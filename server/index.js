import express from 'express'
import { createServer } from 'http'
import { Server } from 'socket.io'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// ---- Constants ----
const MAP_SIZE = 4000
const TICK_RATE = 1000 / 30
const MAX_PELLETS = 500
const GOLD_PELLET_CHANCE = 0.09
const SUPER_PELLET_CHANCE = 0.01
const PELLET_RADIUS = 5
const PELLET_SCORE = 4
const SUPER_RADIUS_MULT = 5
const SUPER_SCORE_MULT = 5
const SUPER_DRIFT_SPEED = 5.2
const GOLD_BONUS_SCORE = 14
const BASE_SPEED = 10
const START_SCORE = 10
const EAT_THRESHOLD = 1.1
const PLAYER_COLORS = [
  '#ff6347', '#4ecdc4', '#ffe66d', '#a855f7',
  '#f97316', '#06b6d4', '#ec4899', '#84cc16',
  '#3b82f6', '#ef4444', '#10b981', '#f59e0b'
]

// ---- Game State ----
const players = {}
let pellets = []
let pelletIdCounter = 0

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

function randomColor() {
  return PLAYER_COLORS[Math.floor(Math.random() * PLAYER_COLORS.length)]
}

function randomSuperVelocity() {
  const a = Math.random() * Math.PI * 2
  return {
    vx: Math.cos(a) * SUPER_DRIFT_SPEED,
    vy: Math.sin(a) * SUPER_DRIFT_SPEED
  }
}

function spawnPellet() {
  const roll = Math.random()
  if (roll < SUPER_PELLET_CHANCE) {
    const radius = PELLET_RADIUS * SUPER_RADIUS_MULT
    const pad = radius + 35
    const pos = {
      x: pad + Math.random() * (MAP_SIZE - pad * 2),
      y: pad + Math.random() * (MAP_SIZE - pad * 2)
    }
    const { vx, vy } = randomSuperVelocity()
    return {
      id: pelletIdCounter++,
      x: pos.x,
      y: pos.y,
      color: '#fef3c7',
      radius,
      kind: 'super',
      vx,
      vy
    }
  }
  const pos = randomPos(10)
  const goldCap = SUPER_PELLET_CHANCE + (1 - SUPER_PELLET_CHANCE) * GOLD_PELLET_CHANCE
  const gold = roll < goldCap
  return {
    id: pelletIdCounter++,
    x: pos.x,
    y: pos.y,
    color: gold ? '#fbbf24' : randomColor(),
    radius: gold ? PELLET_RADIUS * 1.35 : PELLET_RADIUS,
    kind: gold ? 'gold' : 'normal'
  }
}

function stepSuperPellets() {
  for (const pellet of pellets) {
    if (pellet.kind !== 'super' || typeof pellet.vx !== 'number') continue
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
      pellet.vx += (Math.random() - 0.5) * 2.8
      pellet.vy += (Math.random() - 0.5) * 2.8
      const len = Math.hypot(pellet.vx, pellet.vy)
      const scale = SUPER_DRIFT_SPEED / (len || 1)
      pellet.vx *= scale
      pellet.vy *= scale
    }
  }
}

function fillPellets() {
  while (pellets.length < MAX_PELLETS) {
    pellets.push(spawnPellet())
  }
}

function spawnPlayer(id, name) {
  // Try to find a non-overlapping spawn position
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
    alive: true
  }
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

let idleExitTimer = null
function updateIdleRestart() {
  const n = io.of('/').sockets.size
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
        console.log(`Login: ${name} (${socket.id})`)
        spawnPlayer(socket.id, name)
        socket.emit('loggedIn', { id: socket.id })
      } catch (err) {
        console.error(`Error in login handler (${socket.id}):`, err.message)
        socket.emit('error', { message: 'Login failed' })
      }
    })

    socket.on('playerMove', ({ x, y }) => {
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
      } catch (err) {
        console.error(`Error in playerMove handler (${socket.id}):`, err.message)
      }
    })

    socket.on('restart', () => {
      try {
        const old = players[socket.id]
        const name = old ? old.name : 'Player'
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
        delete players[socket.id]
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

let tickCount = 0
setInterval(() => {
  try {
    tickCount++
    if (tickCount % 1800 === 0 && typeof global.gc === 'function') {
      global.gc()
    }

    const alivePlayers = Object.values(players).filter(p => p.alive)

    // Move players
    for (const p of alivePlayers) {
      let speed
      if (p.score <= 250) speed = BASE_SPEED
      else if (p.score <= 1000) speed = 7
      else speed = 3.5
      p.x += p.dx * speed
      p.y += p.dy * speed
      p.x = Math.max(p.radius, Math.min(MAP_SIZE - p.radius, p.x))
      p.y = Math.max(p.radius, Math.min(MAP_SIZE - p.radius, p.y))
    }

    stepSuperPellets()

    // Pellet collisions
    for (const p of alivePlayers) {
      pellets = pellets.filter(pellet => {
        const dist = Math.hypot(p.x - pellet.x, p.y - pellet.y)
        if (dist < p.radius + pellet.radius) {
          let gain = PELLET_SCORE
          if (pellet.kind === 'gold') gain = PELLET_SCORE + GOLD_BONUS_SCORE
          else if (pellet.kind === 'super') gain = PELLET_SCORE * SUPER_SCORE_MULT
          p.score += gain
          p.radius = radiusFromScore(p.score)
          return false
        }
        return true
      })
    }

    // Player vs player collisions
    for (let i = 0; i < alivePlayers.length; i++) {
      for (let j = i + 1; j < alivePlayers.length; j++) {
        const a = alivePlayers[i]
        const b = alivePlayers[j]
        if (!a.alive || !b.alive) continue
        const dist = Math.hypot(a.x - b.x, a.y - b.y)
        const [bigger, smaller] = a.score >= b.score ? [a, b] : [b, a]
        // Bigger must overlap smaller's center and be significantly larger
        if (dist < bigger.radius && bigger.score > smaller.score * EAT_THRESHOLD) {
          bigger.score += Math.floor(smaller.score / 2)
          bigger.radius = radiusFromScore(bigger.score)
          smaller.alive = false
          io.to(smaller.id).emit('playerDied', { killedBy: bigger.name })
        }
      }
    }

    // Respawn pellets
    fillPellets()

    // Broadcast state
    const state = {
      players: Object.values(players).filter(p => p.alive).map(p => ({
        id: p.id, name: p.name, x: p.x, y: p.y,
        score: p.score, radius: p.radius, color: p.color
      })),
      pellets: pellets.map(p => ({
        id: p.id, x: p.x, y: p.y, color: p.color, radius: p.radius,
        kind: p.kind || 'normal'
      }))
    }
    io.emit('gameState', state)
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
