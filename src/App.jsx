import { useState, useEffect, useRef, useCallback } from 'react'
import { io } from 'socket.io-client'

// ---- Toggle this to test frontend without a server ----
const MOCK_MODE = true
// -------------------------------------------------------

const API_URL = 'https://api.netgain.techfullymade.com'
const SERVER_URL = import.meta.env.DEV ? 'http://localhost:3000' : API_URL
const socket = io(SERVER_URL, { autoConnect: false })

const MAP_SIZE = 4000
const PLAYER_NAMES = ['Player 1', 'Player 2', 'Player 3', 'Player 4', 'Player 5', 'Player 6']
const COLORS = ['#f97316', '#a855f7', '#ec4899', '#3b82f6', '#84cc16', '#14b8a6']

function makePellets() {
  return Array.from({ length: 300 }, (_, i) => ({
    id: i,
    x: Math.random() * MAP_SIZE,
    y: Math.random() * MAP_SIZE,
    radius: 4 + Math.random() * 6,
    color: COLORS[Math.floor(Math.random() * COLORS.length)],
  }))
}

export default function App() {
  const [screen, setScreen] = useState('login') // login | game | dead
  const [playerName, setPlayerName] = useState(PLAYER_NAMES[0])
  const [killedBy, setKilledBy] = useState('')
  const [myScore, setMyScore] = useState(0)
  const canvasRef = useRef(null)
  const gameStateRef = useRef({ players: [], pellets: [] })
  const myIdRef = useRef(null)
  const animFrameRef = useRef(null)
  const lastEmitRef = useRef(0)
  const mouseDirRef = useRef({ x: 0, y: 0 })
  const playerNameRef = useRef(playerName)
  const avatarImgRef = useRef(null)

  // Keep playerNameRef in sync
  useEffect(() => { playerNameRef.current = playerName }, [playerName])

  // Preload player avatars
  useEffect(() => {
    const img = new Image()
    img.src = '/player1.jpeg'
    img.onload = () => { avatarImgRef.current = img }
  }, [])

  // Socket listeners (real mode only)
  useEffect(() => {
    if (MOCK_MODE) return

    socket.on('loggedIn', ({ id }) => {
      myIdRef.current = id
      setScreen('game')
    })

    socket.on('gameState', (state) => {
      gameStateRef.current = state
      const me = state.players.find(p => p.id === myIdRef.current)
      if (me) setMyScore(me.score)
    })

    socket.on('playerDied', ({ killedBy }) => {
      setKilledBy(killedBy)
      setScreen('dead')
    })

    return () => {
      socket.off('loggedIn')
      socket.off('gameState')
      socket.off('playerDied')
    }
  }, [])

  // Mock game loop
  useEffect(() => {
    if (!MOCK_MODE || screen !== 'game') return

    const bots = Array.from({ length: 5 }, (_, i) => ({
      id: `bot-${i}`,
      name: PLAYER_NAMES[i + 1] || `Bot ${i + 1}`,
      x: Math.random() * MAP_SIZE,
      y: Math.random() * MAP_SIZE,
      radius: 15 + Math.random() * 25,
      color: COLORS[i % COLORS.length],
      score: 0,
      vx: (Math.random() - 0.5) * 3,
      vy: (Math.random() - 0.5) * 3,
    }))

    const me = {
      id: 'mock-player',
      name: playerName,
      x: MAP_SIZE / 2,
      y: MAP_SIZE / 2,
      radius: 20,
      color: '#0ea5e9',
      score: 0,
    }

    myIdRef.current = 'mock-player'
    gameStateRef.current = { players: [me, ...bots], pellets: makePellets() }

    const interval = setInterval(() => {
      const state = gameStateRef.current
      const player = state.players.find(p => p.id === 'mock-player')
      if (!player) return

      // Move player toward mouse
      const { x: mx, y: my } = mouseDirRef.current
      const dist = Math.sqrt(mx * mx + my * my)
      if (dist > 5) {
        const speed = Math.max(1.5, 5 - player.radius / 40)
        player.x = Math.max(player.radius, Math.min(MAP_SIZE - player.radius, player.x + (mx / dist) * speed))
        player.y = Math.max(player.radius, Math.min(MAP_SIZE - player.radius, player.y + (my / dist) * speed))
      }

      // Move bots (wander + bounce off walls)
      for (const bot of state.players.filter(p => p.id !== 'mock-player')) {
        bot.x += bot.vx
        bot.y += bot.vy
        if (bot.x < bot.radius || bot.x > MAP_SIZE - bot.radius) bot.vx *= -1
        if (bot.y < bot.radius || bot.y > MAP_SIZE - bot.radius) bot.vy *= -1
        bot.x = Math.max(bot.radius, Math.min(MAP_SIZE - bot.radius, bot.x))
        bot.y = Math.max(bot.radius, Math.min(MAP_SIZE - bot.radius, bot.y))
      }

      // Eat players — bigger blob absorbs smaller one's mass
      for (let i = 0; i < state.players.length; i++) {
        const eater = state.players[i]
        for (let j = 0; j < state.players.length; j++) {
          if (i === j) continue
          const prey = state.players[j]
          const dx = eater.x - prey.x
          const dy = eater.y - prey.y
          const dist = Math.sqrt(dx * dx + dy * dy)
          // Must be 10% bigger and overlapping prey's center
          if (eater.radius > prey.radius * 1.1 && dist < eater.radius) {
            // Absorb prey's mass (mass = radius²)
            eater.radius = Math.sqrt(eater.radius * eater.radius + prey.radius * prey.radius)
            if (eater.id === 'mock-player') {
              eater.score += Math.floor(prey.radius * 3)
              setMyScore(eater.score)
            }
            if (prey.id === 'mock-player') {
              // Player got eaten — go to dead screen
              setKilledBy(eater.name)
              setScreen('dead')
              return
            } else {
              // Respawn bot small on the other side of the map
              prey.x = Math.random() * MAP_SIZE
              prey.y = Math.random() * MAP_SIZE
              prey.radius = 15 + Math.random() * 10
              prey.score = 0
            }
          }
        }
      }

      // Eat pellets
      state.pellets = state.pellets.filter(pellet => {
        for (const p of state.players) {
          const dx = p.x - pellet.x
          const dy = p.y - pellet.y
          if (Math.sqrt(dx * dx + dy * dy) < p.radius) {
            p.radius += 1
            if (p.id === 'mock-player') {
              p.score += 1
              setMyScore(p.score)
            }
            return false
          }
        }
        return true
      })

      // Respawn pellets
      while (state.pellets.length < 300) {
        state.pellets.push({
          id: Date.now() + Math.random(),
          x: Math.random() * MAP_SIZE,
          y: Math.random() * MAP_SIZE,
          radius: 4 + Math.random() * 6,
          color: COLORS[Math.floor(Math.random() * COLORS.length)],
        })
      }
    }, 1000 / 30)

    return () => clearInterval(interval)
  }, [screen])

  // Handle play
  const handlePlay = useCallback(() => {
    if (MOCK_MODE) {
      setMyScore(0)
      setScreen('game')
      return
    }
    if (!socket.connected) socket.connect()
    socket.emit('login', { name: playerName })
  }, [playerName])

  // Handle restart
  const handleRestart = useCallback(() => {
    if (MOCK_MODE) {
      setMyScore(0)
      setScreen('game')
      return
    }
    socket.emit('restart')
  }, [])

  // Canvas rendering
  useEffect(() => {
    if (screen !== 'game') {
      if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current)
      return
    }

    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')

    function resize() {
      const dpr = window.devicePixelRatio || 1
      canvas.width = window.innerWidth * dpr
      canvas.height = window.innerHeight * dpr
      canvas.style.width = window.innerWidth + 'px'
      canvas.style.height = window.innerHeight + 'px'
      ctx.scale(dpr, dpr)
    }
    resize()
    window.addEventListener('resize', resize)

    function draw() {
      const w = window.innerWidth
      const h = window.innerHeight
      const state = gameStateRef.current
      const me = state.players.find(p => p.id === myIdRef.current)

      ctx.setTransform(1, 0, 0, 1, 0, 0)
      const dpr = window.devicePixelRatio || 1
      ctx.scale(dpr, dpr)

      // Sand background outside the map
      ctx.fillStyle = '#fde68a'
      ctx.fillRect(0, 0, w, h)

      if (!me) {
        animFrameRef.current = requestAnimationFrame(draw)
        return
      }

      const camX = w / 2 - me.x
      const camY = h / 2 - me.y
      ctx.save()
      ctx.translate(camX, camY)

      // Water inside map
      ctx.fillStyle = '#67e8f9'
      ctx.fillRect(0, 0, MAP_SIZE, MAP_SIZE)

      // Subtle checkerboard water pattern
      const gridSize = 80
      ctx.fillStyle = 'rgba(14, 165, 233, 0.18)'
      const startX = Math.floor(Math.max(0, -camX) / gridSize) * gridSize
      const endX = Math.min(MAP_SIZE, -camX + w + gridSize)
      const startY = Math.floor(Math.max(0, -camY) / gridSize) * gridSize
      const endY = Math.min(MAP_SIZE, -camY + h + gridSize)
      for (let x = startX; x < endX; x += gridSize) {
        for (let y = startY; y < endY; y += gridSize) {
          if (((x / gridSize) + (y / gridSize)) % 2 === 0) {
            ctx.fillRect(x, y, gridSize, gridSize)
          }
        }
      }

      // Sandy beach border
      ctx.strokeStyle = '#f59e0b'
      ctx.lineWidth = 20
      ctx.strokeRect(0, 0, MAP_SIZE, MAP_SIZE)
      ctx.strokeStyle = '#fcd34d'
      ctx.lineWidth = 6
      ctx.strokeRect(0, 0, MAP_SIZE, MAP_SIZE)

      // Pellets — tropical fruit dots
      for (const pellet of state.pellets) {
        if (pellet.x < -camX - 20 || pellet.x > -camX + w + 20) continue
        if (pellet.y < -camY - 20 || pellet.y > -camY + h + 20) continue
        ctx.beginPath()
        ctx.arc(pellet.x, pellet.y, pellet.radius, 0, Math.PI * 2)
        ctx.fillStyle = pellet.color
        ctx.fill()
        ctx.strokeStyle = 'rgba(255,255,255,0.5)'
        ctx.lineWidth = 1.5
        ctx.stroke()
      }

      // Players
      for (const player of state.players) {
        const isMe = player.id === myIdRef.current

        // Dashed selection ring for self
        if (isMe) {
          ctx.save()
          ctx.setLineDash([6, 4])
          ctx.beginPath()
          ctx.arc(player.x, player.y, player.radius + 6, 0, Math.PI * 2)
          ctx.strokeStyle = '#f59e0b'
          ctx.lineWidth = 2.5
          ctx.stroke()
          ctx.setLineDash([])
          ctx.restore()
        }

        // Blob
        const usePhoto = isMe && playerNameRef.current === 'Player 1' && avatarImgRef.current
        ctx.save()
        ctx.beginPath()
        ctx.arc(player.x, player.y, player.radius, 0, Math.PI * 2)
        if (usePhoto) {
          ctx.clip()
          const d = player.radius * 2
          ctx.drawImage(avatarImgRef.current, player.x - player.radius, player.y - player.radius, d, d)
        } else {
          ctx.fillStyle = player.color
          ctx.fill()
        }
        ctx.restore()
        ctx.beginPath()
        ctx.arc(player.x, player.y, player.radius, 0, Math.PI * 2)
        ctx.strokeStyle = 'rgba(255,255,255,0.6)'
        ctx.lineWidth = 3
        ctx.stroke()

        // Shine spot (skip on photo blobs so the face shows clearly)
        if (!usePhoto) {
          ctx.beginPath()
          ctx.arc(
            player.x - player.radius * 0.28,
            player.y - player.radius * 0.28,
            player.radius * 0.22, 0, Math.PI * 2
          )
          ctx.fillStyle = 'rgba(255,255,255,0.35)'
          ctx.fill()
        }

      }

      ctx.restore()

      // HUD score
      ctx.font = 'bold 20px Quicksand, sans-serif'
      ctx.textAlign = 'left'
      ctx.textBaseline = 'top'
      const scoreText = `Score: ${me.score}`
      const sw = ctx.measureText(scoreText).width
      ctx.fillStyle = 'rgba(255,255,255,0.85)'
      ctx.beginPath()
      ctx.roundRect(12, 12, sw + 28, 38, 20)
      ctx.fill()
      ctx.fillStyle = '#0369a1'
      ctx.fillText(scoreText, 26, 21)

      // Mock mode badge
      if (MOCK_MODE) {
        ctx.font = 'bold 13px Courier New'
        ctx.fillStyle = '#f97316'
        ctx.textAlign = 'right'
        ctx.textBaseline = 'top'
        ctx.fillText('⚠ MOCK MODE', w - 20, 20)
      }

      // Minimap
      const mmSize = 150
      const mmX = w - mmSize - 15
      const mmY = h - mmSize - 15
      const mmScale = mmSize / MAP_SIZE

      ctx.fillStyle = 'rgba(255,255,255,0.8)'
      ctx.beginPath()
      ctx.roundRect(mmX - 4, mmY - 4, mmSize + 8, mmSize + 8, 8)
      ctx.fill()
      ctx.fillStyle = '#67e8f9'
      ctx.fillRect(mmX, mmY, mmSize, mmSize)
      ctx.strokeStyle = '#f59e0b'
      ctx.lineWidth = 2
      ctx.strokeRect(mmX, mmY, mmSize, mmSize)

      for (const player of state.players) {
        ctx.beginPath()
        ctx.arc(
          mmX + player.x * mmScale,
          mmY + player.y * mmScale,
          player.id === myIdRef.current ? 4 : 2,
          0, Math.PI * 2
        )
        ctx.fillStyle = player.id === myIdRef.current ? '#f59e0b' : player.color
        ctx.fill()
      }

      ctx.strokeStyle = 'rgba(0,0,0,0.3)'
      ctx.lineWidth = 1
      ctx.strokeRect(
        mmX + (-camX) * mmScale,
        mmY + (-camY) * mmScale,
        w * mmScale,
        h * mmScale
      )

      animFrameRef.current = requestAnimationFrame(draw)
    }

    animFrameRef.current = requestAnimationFrame(draw)

    return () => {
      window.removeEventListener('resize', resize)
      if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current)
    }
  }, [screen])

  // Mouse movement
  useEffect(() => {
    if (screen !== 'game') return

    function handleMouseMove(e) {
      const cx = window.innerWidth / 2
      const cy = window.innerHeight / 2
      const dx = e.clientX - cx
      const dy = e.clientY - cy
      mouseDirRef.current = { x: dx, y: dy }

      if (!MOCK_MODE) {
        const now = Date.now()
        if (now - lastEmitRef.current < 33) return
        lastEmitRef.current = now
        socket.emit('playerMove', { x: dx, y: dy })
      }
    }

    window.addEventListener('mousemove', handleMouseMove)
    return () => window.removeEventListener('mousemove', handleMouseMove)
  }, [screen])

  // ---- Render ----
  if (screen === 'login') {
    return (
      <div className="login-screen">
        <h1 className="game-title">NetGame</h1>
        <p className="game-subtitle">Eat or be eaten</p>
        {MOCK_MODE && <p className="mock-badge">⚠ Mock Mode — no server needed</p>}
        <img
          src={playerName === 'Player 1' ? '/player1.jpeg' : `https://placehold.co/120x120/0ea5e9/ffffff?text=P${PLAYER_NAMES.indexOf(playerName) + 1}`}
          alt={playerName}
          className="player-avatar"
        />
        <select
          className="name-select"
          value={playerName}
          onChange={e => setPlayerName(e.target.value)}
        >
          {PLAYER_NAMES.map(name => (
            <option key={name} value={name}>{name}</option>
          ))}
        </select>
        <button className="play-btn" onClick={handlePlay}>Play</button>
      </div>
    )
  }

  if (screen === 'dead') {
    return (
      <div className="dead-screen">
        <h1 className="dead-title">GAME OVER</h1>
        <p className="dead-info">Eaten by <span className="killer-name">{killedBy}</span></p>
        <p className="dead-score">Final score: {myScore}</p>
        <button className="play-btn" onClick={handleRestart}>Play Again</button>
      </div>
    )
  }

  return <canvas ref={canvasRef} className="game-canvas" />
}
