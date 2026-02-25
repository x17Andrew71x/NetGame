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
const PELLET_RADIUS = 5
const BASE_SPEED = 5
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

function spawnPellet() {
  const pos = randomPos(10)
  return {
    id: pelletIdCounter++,
    x: pos.x,
    y: pos.y,
    color: randomColor(),
    radius: PELLET_RADIUS
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
const app = express()
app.use(express.static(path.join(__dirname, '../dist')))

const httpServer = createServer(app)
const io = new Server(httpServer, {
  cors: { origin: '*' }
})

// ---- Socket Handlers ----
io.on('connection', (socket) => {
  console.log(`Connected: ${socket.id}`)

  socket.on('login', ({ name }) => {
    console.log(`Login: ${name} (${socket.id})`)
    spawnPlayer(socket.id, name)
    socket.emit('loggedIn', { id: socket.id })
  })

  socket.on('playerMove', ({ x, y }) => {
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
  })

  socket.on('restart', () => {
    const old = players[socket.id]
    const name = old ? old.name : 'Player'
    spawnPlayer(socket.id, name)
    socket.emit('loggedIn', { id: socket.id })
  })

  socket.on('disconnect', () => {
    console.log(`Disconnected: ${socket.id}`)
    delete players[socket.id]
  })
})

// ---- Game Loop ----
fillPellets()

setInterval(() => {
  const alivePlayers = Object.values(players).filter(p => p.alive)

  // Move players
  for (const p of alivePlayers) {
    const speed = BASE_SPEED / Math.sqrt(p.score / START_SCORE)
    p.x += p.dx * speed
    p.y += p.dy * speed
    p.x = Math.max(p.radius, Math.min(MAP_SIZE - p.radius, p.x))
    p.y = Math.max(p.radius, Math.min(MAP_SIZE - p.radius, p.y))
  }

  // Pellet collisions
  for (const p of alivePlayers) {
    pellets = pellets.filter(pellet => {
      const dist = Math.hypot(p.x - pellet.x, p.y - pellet.y)
      if (dist < p.radius + pellet.radius) {
        p.score += 1
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
      id: p.id, x: p.x, y: p.y, color: p.color, radius: p.radius
    }))
  }
  io.emit('gameState', state)
}, TICK_RATE)

// ---- Start ----
const PORT = process.env.PORT || 3000
httpServer.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`)
})
