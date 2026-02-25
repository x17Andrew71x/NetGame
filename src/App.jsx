import { useState, useEffect, useRef, useCallback } from 'react'
import { io } from 'socket.io-client'

const SERVER_URL = import.meta.env.DEV ? 'http://localhost:3000' : window.location.origin
const socket = io(SERVER_URL, { autoConnect: false })

const MAP_SIZE = 4000
const PLAYER_NAMES = ['Player 1', 'Player 2', 'Player 3', 'Player 4', 'Player 5', 'Player 6']

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

  // Socket listeners
  useEffect(() => {
    socket.on('loggedIn', ({ id }) => {
      myIdRef.current = id
      setScreen('game')
    })

    socket.on('gameState', (state) => {
      gameStateRef.current = state
      // Update score for HUD (only this triggers a re-render)
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

  // Handle play
  const handlePlay = useCallback(() => {
    if (!socket.connected) socket.connect()
    socket.emit('login', { name: playerName })
  }, [playerName])

  // Handle restart
  const handleRestart = useCallback(() => {
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

      // Clear
      ctx.setTransform(1, 0, 0, 1, 0, 0)
      const dpr = window.devicePixelRatio || 1
      ctx.scale(dpr, dpr)
      ctx.fillStyle = '#111'
      ctx.fillRect(0, 0, w, h)

      if (!me) {
        animFrameRef.current = requestAnimationFrame(draw)
        return
      }

      // Camera offset
      const camX = w / 2 - me.x
      const camY = h / 2 - me.y
      ctx.save()
      ctx.translate(camX, camY)

      // Grid
      const gridSize = 40
      ctx.strokeStyle = '#222'
      ctx.lineWidth = 1
      const startX = Math.floor(Math.max(0, -camX) / gridSize) * gridSize
      const endX = Math.min(MAP_SIZE, -camX + w + gridSize)
      const startY = Math.floor(Math.max(0, -camY) / gridSize) * gridSize
      const endY = Math.min(MAP_SIZE, -camY + h + gridSize)

      for (let x = startX; x <= endX; x += gridSize) {
        ctx.beginPath()
        ctx.moveTo(x, Math.max(0, startY))
        ctx.lineTo(x, Math.min(MAP_SIZE, endY))
        ctx.stroke()
      }
      for (let y = startY; y <= endY; y += gridSize) {
        ctx.beginPath()
        ctx.moveTo(Math.max(0, startX), y)
        ctx.lineTo(Math.min(MAP_SIZE, endX), y)
        ctx.stroke()
      }

      // Map border
      ctx.strokeStyle = '#f44'
      ctx.lineWidth = 4
      ctx.strokeRect(0, 0, MAP_SIZE, MAP_SIZE)

      // Pellets
      for (const pellet of state.pellets) {
        if (pellet.x < -camX - 20 || pellet.x > -camX + w + 20) continue
        if (pellet.y < -camY - 20 || pellet.y > -camY + h + 20) continue
        ctx.beginPath()
        ctx.arc(pellet.x, pellet.y, pellet.radius, 0, Math.PI * 2)
        ctx.fillStyle = pellet.color
        ctx.fill()
      }

      // Players
      for (const player of state.players) {
        // Circle
        ctx.beginPath()
        ctx.arc(player.x, player.y, player.radius, 0, Math.PI * 2)
        ctx.fillStyle = player.color
        ctx.globalAlpha = 0.85
        ctx.fill()
        ctx.globalAlpha = 1
        ctx.strokeStyle = 'rgba(255,255,255,0.3)'
        ctx.lineWidth = 2
        ctx.stroke()

        // Name label
        const fontSize = Math.max(12, player.radius * 0.4)
        ctx.font = `bold ${fontSize}px 'Courier New', monospace`
        ctx.fillStyle = '#fff'
        ctx.textAlign = 'center'
        ctx.textBaseline = 'middle'
        ctx.fillText(player.name, player.x, player.y)
      }

      ctx.restore()

      // HUD - Score
      ctx.font = 'bold 24px Courier New'
      ctx.fillStyle = '#0f8'
      ctx.textAlign = 'left'
      ctx.textBaseline = 'top'
      ctx.fillText(`Score: ${me.score}`, 20, 20)

      // Minimap
      const mmSize = 150
      const mmX = w - mmSize - 15
      const mmY = h - mmSize - 15
      const mmScale = mmSize / MAP_SIZE

      ctx.fillStyle = 'rgba(0,0,0,0.6)'
      ctx.fillRect(mmX, mmY, mmSize, mmSize)
      ctx.strokeStyle = '#555'
      ctx.lineWidth = 1
      ctx.strokeRect(mmX, mmY, mmSize, mmSize)

      // Minimap players
      for (const player of state.players) {
        ctx.beginPath()
        ctx.arc(
          mmX + player.x * mmScale,
          mmY + player.y * mmScale,
          player.id === myIdRef.current ? 4 : 2,
          0, Math.PI * 2
        )
        ctx.fillStyle = player.id === myIdRef.current ? '#0f8' : player.color
        ctx.fill()
      }

      // Minimap viewport box
      ctx.strokeStyle = '#fff'
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

  // Mouse movement -> send direction to server
  useEffect(() => {
    if (screen !== 'game') return

    function handleMouseMove(e) {
      const now = Date.now()
      if (now - lastEmitRef.current < 33) return // throttle to ~30Hz
      lastEmitRef.current = now

      const cx = window.innerWidth / 2
      const cy = window.innerHeight / 2
      const dx = e.clientX - cx
      const dy = e.clientY - cy
      socket.emit('playerMove', { x: dx, y: dy })
    }

    window.addEventListener('mousemove', handleMouseMove)
    return () => window.removeEventListener('mousemove', handleMouseMove)
  }, [screen])

  // ---- Render ----
  if (screen === 'login') {
    return (
      <div className="login-screen">
        <h1 className="game-title">BLOB.IO</h1>
        <p className="game-subtitle">Eat or be eaten</p>
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
