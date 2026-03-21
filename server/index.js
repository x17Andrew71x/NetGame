import express from 'express'
import { createServer } from 'http'
import { Server } from 'socket.io'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// ---- Constants ----
const MAP_SIZE = 4000
const TICK_RATE = 1000 / 30
const MAX_PELLETS = 375
const NORMALS_PER_GOLD = 100
const PELLET_RADIUS = 5
const PELLET_SCORE = 4
const GOLD_PELLET_SCORE = PELLET_SCORE * 10
const GOLD_RADIUS_MULT = 3
const GOLD_SPEED_MIN = 3
const GOLD_SPEED_MAX = 6
const NORMAL_DRIFT_MAX = 0.25
const START_SCORE = 10

// ---- Henry bot ----
const HENRY_BOT_ID = '__henry__'
const HENRY_START_SCORE = 5000
const HENRY_SCORE_MULT = 3
const HENRY_SPEED_MIN = 17
const HENRY_SPEED_MAX = 20
const HENRY_RADIUS_START_MULT = 25
const HENRY_RESPAWN_DELAY = 5000
// ~0.0035/frame @ 30Hz ≈ every 9–10s on average (extra to wall bounces + eat turns)
const HENRY_RANDOM_STEER_CHANCE = 0.0035

// Movement speed by score — many small steps; early tiers are faster than before.
// Each [minScore, speed]: at or above minScore use this speed (scan from high to low).
const SPEED_TIERS = [
  [52000, 0.8], [40000, 0.88], [31000, 0.96], [25000, 1.05], [20500, 1.14],
  [17000, 1.24], [14200, 1.35], [12000, 1.47], [10200, 1.6], [8700, 1.74],
  [7400, 1.9], [6300, 2.08], [5400, 2.28], [4600, 2.5], [3900, 2.75],
  [3300, 3.02], [2780, 3.32], [2340, 3.65], [1960, 4], [1640, 4.38],
  [1360, 4.78], [1120, 5.2], [920, 5.65], [750, 6.1], [600, 6.55],
  [470, 7], [360, 7.45], [265, 7.9], [185, 8.35], [115, 9.1],
  [55, 9.85], [0, 10.6]
]

function speedFromScore(score) {
  const s = Number(score) || 0
  for (let i = 0; i < SPEED_TIERS.length; i++) {
    const [thr, sp] = SPEED_TIERS[i]
    if (s >= thr) return sp
  }
  return SPEED_TIERS[SPEED_TIERS.length - 1][1]
}
const EAT_THRESHOLD = 1.1
const PLAYER_NAME_MAX = 15

function sanitizePlayerName(name) {
  if (name == null || typeof name !== 'string') return 'Player'
  const s = name
    .replace(/[^A-Za-z0-9 ]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, PLAYER_NAME_MAX)
  return s || 'Player'
}
const PLAYER_COLORS = [
  '#ff6347', '#4ecdc4', '#ffe66d', '#a855f7',
  '#f97316', '#06b6d4', '#ec4899', '#84cc16',
  '#3b82f6', '#ef4444', '#10b981', '#f59e0b'
]

// ---- Game State ----
const players = {}
let pellets = []
let pelletIdCounter = 0
const socketViewports = new Map() // socketId -> { cx, cy, zoom, sw, sh }
const VIEWPORT_BUFFER = 400      // extra world-unit margin around the visible rect

// ---- Helpers ----
function randomPos(margin = 100) {
  return {
    x: margin + Math.random() * (MAP_SIZE - margin * 2),
    y: margin + Math.random() * (MAP_SIZE - margin * 2)
  }
}

function radiusFromScore(score) {
  return Math.sqrt(score) * 4
}

const HENRY_FIXED_RADIUS = HENRY_RADIUS_START_MULT * radiusFromScore(START_SCORE)

function randomColor() {
  return PLAYER_COLORS[Math.floor(Math.random() * PLAYER_COLORS.length)]
}

function randomGoldVelocity() {
  const sp = GOLD_SPEED_MIN + Math.random() * (GOLD_SPEED_MAX - GOLD_SPEED_MIN)
  const a = Math.random() * Math.PI * 2
  return { vx: Math.cos(a) * sp, vy: Math.sin(a) * sp }
}

function clampGoldSpeed(pellet) {
  const len = Math.hypot(pellet.vx, pellet.vy)
  if (len < 1e-6) {
    const v = randomGoldVelocity()
    pellet.vx = v.vx
    pellet.vy = v.vy
    return
  }
  const sp = GOLD_SPEED_MIN + Math.random() * (GOLD_SPEED_MAX - GOLD_SPEED_MIN)
  pellet.vx = (pellet.vx / len) * sp
  pellet.vy = (pellet.vy / len) * sp
}

function spawnNormalPellet() {
  const pos = randomPos(10)
  const stationary = Math.random() < 0.45
  let vx = 0
  let vy = 0
  if (!stationary) {
    const s = 0.1 + Math.random() * (NORMAL_DRIFT_MAX - 0.1)
    const a = Math.random() * Math.PI * 2
    vx = Math.cos(a) * s
    vy = Math.sin(a) * s
  }
  return {
    id: pelletIdCounter++,
    x: pos.x,
    y: pos.y,
    color: randomColor(),
    radius: PELLET_RADIUS,
    kind: 'normal',
    vx,
    vy
  }
}

function spawnGoldPellet() {
  const radius = PELLET_RADIUS * GOLD_RADIUS_MULT
  const pad = radius + 20
  const pos = {
    x: pad + Math.random() * (MAP_SIZE - pad * 2),
    y: pad + Math.random() * (MAP_SIZE - pad * 2)
  }
  const { vx, vy } = randomGoldVelocity()
  return {
    id: pelletIdCounter++,
    x: pos.x,
    y: pos.y,
    color: '#fbbf24',
    radius,
    kind: 'gold',
    imgIdx: Math.floor(Math.random() * 2),
    vx,
    vy
  }
}

function shouldSpawnGold() {
  const n = pellets.filter(p => p.kind === 'normal').length
  const g = pellets.filter(p => p.kind === 'gold').length
  return g < Math.floor(n / NORMALS_PER_GOLD)
}

function stepDriftingPellets() {
  for (const pellet of pellets) {
    if (pellet.kind === 'gold') {
      if (Math.random() < 0.03) {
        const v = randomGoldVelocity()
        pellet.vx = v.vx
        pellet.vy = v.vy
      }
    } else if (pellet.kind === 'normal' && (pellet.vx || pellet.vy)) {
      if (Math.random() < 0.04) {
        pellet.vx += (Math.random() - 0.5) * 0.06
        pellet.vy += (Math.random() - 0.5) * 0.06
        const len = Math.hypot(pellet.vx, pellet.vy)
        if (len > NORMAL_DRIFT_MAX) {
          const s = NORMAL_DRIFT_MAX / len
          pellet.vx *= s
          pellet.vy *= s
        }
      }
    }

    if (typeof pellet.vx !== 'number' || typeof pellet.vy !== 'number') continue
    pellet.x += pellet.vx
    pellet.y += pellet.vy
    const rad = pellet.radius
    let bounced = false
    if (pellet.x < rad) {
      pellet.x = rad
      pellet.vx *= -1
      bounced = true
    } else if (pellet.x > MAP_SIZE - rad) {
      pellet.x = MAP_SIZE - rad
      pellet.vx *= -1
      bounced = true
    }
    if (pellet.y < rad) {
      pellet.y = rad
      pellet.vy *= -1
      bounced = true
    } else if (pellet.y > MAP_SIZE - rad) {
      pellet.y = MAP_SIZE - rad
      pellet.vy *= -1
      bounced = true
    }
    if (bounced) {
      if (pellet.kind === 'gold') {
        pellet.vx += (Math.random() - 0.5) * 1.2
        pellet.vy += (Math.random() - 0.5) * 1.2
        clampGoldSpeed(pellet)
      } else if (pellet.kind === 'normal' && (pellet.vx || pellet.vy)) {
        pellet.vx += (Math.random() - 0.5) * 0.04
        pellet.vy += (Math.random() - 0.5) * 0.04
        const len = Math.hypot(pellet.vx, pellet.vy)
        if (len > NORMAL_DRIFT_MAX) {
          const s = NORMAL_DRIFT_MAX / (len || 1)
          pellet.vx *= s
          pellet.vy *= s
        }
      }
    }
  }
}

function fillPellets() {
  while (pellets.length < MAX_PELLETS) {
    pellets.push(shouldSpawnGold() ? spawnGoldPellet() : spawnNormalPellet())
  }
}

function spawnPlayer(id, name) {
  let pos
  let attempts = 0
  do {
    pos = randomPos(200)
    attempts++
  } while (attempts < 20 && Object.values(players).some(p => {
    const dist = Math.hypot(p.x - pos.x, p.y - pos.y)
    return dist < radiusFromScore(p.score) + radiusFromScore(START_SCORE) + 50
  }))

  players[id] = {
    id,
    name,
    x: pos.x,
    y: pos.y,
    score: START_SCORE,
    radius: radiusFromScore(START_SCORE),
    color: randomColor(),
    dx: 0,
    dy: 0,
    alive: true,
    isHenry: false
  }
}

// Henry: boss bot — fixed size, random walk; new direction on each eat.
let henryRespawnTimer = null

function henryNewDirection() {
  const henry = players[HENRY_BOT_ID]
  if (!henry?.alive) return
  const a = Math.random() * Math.PI * 2
  henry.dx = Math.cos(a)
  henry.dy = Math.sin(a)
}

function spawnHenry() {
  if (players[HENRY_BOT_ID]?.alive) return
  const margin = HENRY_FIXED_RADIUS + 60
  const pos = {
    x: margin + Math.random() * (MAP_SIZE - margin * 2),
    y: margin + Math.random() * (MAP_SIZE - margin * 2)
  }
  const a = Math.random() * Math.PI * 2
  players[HENRY_BOT_ID] = {
    id: HENRY_BOT_ID,
    name: 'HenryaBOT',
    x: pos.x,
    y: pos.y,
    score: HENRY_START_SCORE,
    radius: HENRY_FIXED_RADIUS,
    color: '#f59e0b',
    dx: Math.cos(a),
    dy: Math.sin(a),
    henrySpeed: HENRY_SPEED_MIN + Math.random() * (HENRY_SPEED_MAX - HENRY_SPEED_MIN),
    alive: true,
    isHenry: true
  }
}

function scheduleHenryRespawn() {
  if (henryRespawnTimer) return
  henryRespawnTimer = setTimeout(() => {
    henryRespawnTimer = null
    spawnHenry()
  }, HENRY_RESPAWN_DELAY)
}

// ---- Express + Socket.IO ----
const RESTART_TOKEN = process.env.RESTART_TOKEN || 'netgame-dev-restart'
const IDLE_RESTART_MS = parseInt(process.env.IDLE_RESTART_MS || String(15 * 60 * 1000), 10)

const app = express()
app.use(express.json())

// Hidden ops (wrong token → 404). POST JSON or query: { token } / ?token=
app.post('/__netgame/restart', (req, res) => {
  const token = req.query.token || req.body?.token
  if (token !== RESTART_TOKEN) {
    res.status(404).send('Not found')
    return
  }
  res.json({ ok: true, restarting: true })
  setTimeout(() => process.exit(0), 200)
})

app.use(express.static(path.join(__dirname, '../dist')))

const httpServer = createServer(app)
const io = new Server(httpServer, {
  cors: { origin: '*' }
})

function connectedClientCount() {
  return io.of('/').sockets.size
}

let idleExitTimer = null
function updateIdleRestart() {
  const n = connectedClientCount()
  if (n === 0) {
    if (!idleExitTimer) {
      idleExitTimer = setTimeout(() => {
        console.log('[maintenance] idle: no clients, exiting (container should restart)')
        process.exit(0)
      }, IDLE_RESTART_MS)
    }
  } else if (idleExitTimer) {
    clearTimeout(idleExitTimer)
    idleExitTimer = null
  }
}

// ---- Socket Handlers ----
io.on('connection', (socket) => {
  try {
    console.log(`Connected: ${socket.id}`)
    updateIdleRestart()

    socket.on('login', ({ name }) => {
      try {
        const safe = sanitizePlayerName(name)
        console.log(`Login: ${safe} (${socket.id})`)
        spawnPlayer(socket.id, safe)
        socket.emit('loggedIn', { id: socket.id })
      } catch (err) {
        console.error(`Error in login handler (${socket.id}):`, err.message)
        socket.emit('error', { message: 'Login failed' })
      }
    })

    socket.on('playerMove', ({ x, y, cx, cy, zoom, sw, sh }) => {
      try {
        const player = players[socket.id]
        if (!player || !player.alive) return
        // Normalize direction
        const len = Math.hypot(x, y)
        if (len > 0) {
          player.dx = x / len
          player.dy = y / len
        } else {
          player.dx = 0
          player.dy = 0
        }
        // Store viewport for per-socket culling
        if (cx != null && sw > 0 && sh > 0 && zoom > 0) {
          socketViewports.set(socket.id, { cx, cy, zoom, sw, sh })
        }
      } catch (err) {
        console.error(`Error in playerMove handler (${socket.id}):`, err.message)
      }
    })

    socket.on('restart', () => {
      try {
        const old = players[socket.id]
        const name = sanitizePlayerName(old ? old.name : 'Player')
        spawnPlayer(socket.id, name)
        socket.emit('loggedIn', { id: socket.id })
      } catch (err) {
        console.error(`Error in restart handler (${socket.id}):`, err.message)
        socket.emit('error', { message: 'Restart failed' })
      }
    })

    socket.on('disconnect', () => {
      try {
        console.log(`Disconnected: ${socket.id}`)
        if (socket.id !== HENRY_BOT_ID) delete players[socket.id]
        socketViewports.delete(socket.id)
        updateIdleRestart()
      } catch (err) {
        console.error(`Error in disconnect handler (${socket.id}):`, err.message)
      }
    })
  } catch (err) {
    console.error(`Error setting up connection (${socket.id}):`, err.message)
  }
})

// ---- Game Loop ----
fillPellets()
spawnHenry()

let tickCount = 0
setInterval(() => {
  try {
    // No humans connected — freeze simulation (Henry won't farm pellets; no CPU work)
    if (connectedClientCount() === 0) return

    tickCount++
    if (tickCount % 1800 === 0 && typeof global.gc === 'function') {
      global.gc()
    }

    // Ensure Henry is always present
    if (!players[HENRY_BOT_ID]?.alive) scheduleHenryRespawn()

    const alivePlayers = Object.values(players).filter(p => p.alive)

    // Move players — Henry: bounce off walls + occasional random steer (never clamp-stuck in corners)
    for (const p of alivePlayers) {
      if (p.isHenry) {
        const sp = p.henrySpeed ?? HENRY_SPEED_MIN
        p.x += p.dx * sp
        p.y += p.dy * sp
        const r = p.radius
        if (p.x < r) {
          p.x = r
          p.dx *= -1
        } else if (p.x > MAP_SIZE - r) {
          p.x = MAP_SIZE - r
          p.dx *= -1
        }
        if (p.y < r) {
          p.y = r
          p.dy *= -1
        } else if (p.y > MAP_SIZE - r) {
          p.y = MAP_SIZE - r
          p.dy *= -1
        }
        if (Math.random() < HENRY_RANDOM_STEER_CHANCE) henryNewDirection()
        continue
      }
      const speed = speedFromScore(p.score)
      p.x += p.dx * speed
      p.y += p.dy * speed
      p.x = Math.max(p.radius, Math.min(MAP_SIZE - p.radius, p.x))
      p.y = Math.max(p.radius, Math.min(MAP_SIZE - p.radius, p.y))
    }

    stepDriftingPellets()

    // Pellet collisions (visual radius for overlap)
    for (const p of alivePlayers) {
      if (!p.alive) continue
      pellets = pellets.filter(pellet => {
        const dist = Math.hypot(p.x - pellet.x, p.y - pellet.y)
        if (dist < p.radius + pellet.radius) {
          let gain = pellet.kind === 'gold' ? GOLD_PELLET_SCORE : PELLET_SCORE
          if (p.isHenry) {
            gain = Math.ceil(gain * HENRY_SCORE_MULT)
            henryNewDirection()
          }
          p.score += gain
          if (!p.isHenry) p.radius = radiusFromScore(p.score)
          return false
        }
        return true
      })
    }

    // Player vs player — visual radius for overlap, score determines who wins
    for (let i = 0; i < alivePlayers.length; i++) {
      for (let j = i + 1; j < alivePlayers.length; j++) {
        const a = alivePlayers[i]
        const b = alivePlayers[j]
        if (!a.alive || !b.alive) continue
        const dist = Math.hypot(a.x - b.x, a.y - b.y)
        const [bigger, smaller] = a.score >= b.score ? [a, b] : [b, a]
        // Boss bot is never consumable (avoids farm loop). Score order still blocks Henry eating bigger players.
        if (dist < bigger.radius && bigger.score > smaller.score * EAT_THRESHOLD) {
          if (smaller.isHenry) continue
          const gain = Math.floor(smaller.score / 2)
          bigger.score += bigger.isHenry ? Math.ceil(gain * HENRY_SCORE_MULT) : gain
          if (!bigger.isHenry) bigger.radius = radiusFromScore(bigger.score)
          if (bigger.isHenry) henryNewDirection()
          smaller.alive = false
          io.to(smaller.id).emit('playerDied', { killedBy: bigger.name })
        }
      }
    }

    // Respawn pellets
    fillPellets()

    // Broadcast state — serialize once, filter pellets per-socket by viewport
    const allPlayersData = Object.values(players).filter(p => p.alive).map(p => ({
      id: p.id, name: p.name, x: p.x, y: p.y,
      score: p.score, radius: p.radius, color: p.color,
      isHenry: p.isHenry || false
    }))
    const allPelletsData = pellets.map(p => ({
      id: p.id, x: p.x, y: p.y, color: p.color, radius: p.radius,
      kind: p.kind || 'normal',
      ...(p.kind === 'gold' ? { imgIdx: p.imgIdx != null ? p.imgIdx : (p.id % 2) } : {})
    }))
    for (const [sid, sock] of io.of('/').sockets) {
      const vp = socketViewports.get(sid)
      let visiblePellets
      if (vp) {
        const hw = (vp.sw / vp.zoom) / 2 + VIEWPORT_BUFFER
        const hh = (vp.sh / vp.zoom) / 2 + VIEWPORT_BUFFER
        const left = vp.cx - hw, right = vp.cx + hw
        const top = vp.cy - hh, bottom = vp.cy + hh
        visiblePellets = allPelletsData.filter(p =>
          p.x >= left && p.x <= right && p.y >= top && p.y <= bottom
        )
      } else {
        visiblePellets = allPelletsData
      }
      sock.emit('gameState', { players: allPlayersData, pellets: visiblePellets })
    }
  } catch (err) {
    console.error('Error in game loop tick:', err.message)
    console.error(err.stack)
  }
}, TICK_RATE)

// ---- Error Handlers ----
process.on('uncaughtException', (err) => {
  console.error('UNCAUGHT EXCEPTION:', err.message)
  console.error(err.stack)
  // Server stays running
})

process.on('unhandledRejection', (reason, promise) => {
  console.error('UNHANDLED REJECTION:', reason)
  // Server stays running
})

io.on('error', (err) => {
  console.error('Socket.IO error:', err.message)
})

// ---- Start ----
const PORT = process.env.PORT || 3000
httpServer.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`)
  console.log(`[maintenance] idle restart after ${IDLE_RESTART_MS}ms with 0 clients`)
  setImmediate(updateIdleRestart)
})

httpServer.on('error', (err) => {
  console.error('HTTP Server error:', err.message)
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use`)
  }
})
