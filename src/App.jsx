import { useState, useEffect, useRef, useCallback } from 'react'
import { io } from 'socket.io-client'

// ---- Toggle this to test frontend without a server ----
const MOCK_MODE = false
// -------------------------------------------------------

const API_URL = 'https://api.netgain.techfullymade.com'
const SERVER_URL = import.meta.env.DEV ? 'http://localhost:3000' : API_URL
const socket = io(SERVER_URL, { autoConnect: false })

// Game picker catalog — add `ready: true` + handler when wiring a new game
const GAME_CATALOG = [
  { id: 'netgame', title: 'NetGame', blurb: 'Eat or be eaten', icon: '🌊', ready: true },
  { id: 'soon-a', ready: false },
  { id: 'soon-b', ready: false },
  { id: 'soon-c', ready: false },
]

const PLAYER_NAME_MAX = 15
const DEFAULT_PLAYER_NAME = 'Player'

function sanitizePlayerNameInput(raw) {
  return String(raw)
    .replace(/[^A-Za-z0-9 ]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, PLAYER_NAME_MAX)
}

function loadPlayerNameFromStorage() {
  const cleaned = sanitizePlayerNameInput(localStorage.getItem('playerName') || '')
  return cleaned || DEFAULT_PLAYER_NAME
}

function effectivePlayerName(name) {
  const s = sanitizePlayerNameInput(name)
  return s || DEFAULT_PLAYER_NAME
}

const MAP_SIZE = 4000
const MOCK_MAX_PELLETS = 225
const MOCK_NORMALS_PER_GOLD = 100
const MOCK_PELLET_RADIUS = 5
const MOCK_GOLD_RADIUS = MOCK_PELLET_RADIUS * 3
const MOCK_PELLET_SCORE = 4
const MOCK_GOLD_SCORE = MOCK_PELLET_SCORE * 10
const MOCK_HENRY_PELLET_MULT = 3
const SERVER_START_SCORE = 10
const MOCK_HENRY_FIXED_RADIUS = 25 * Math.sqrt(SERVER_START_SCORE) * 4
const MOCK_HENRY_RANDOM_STEER = 0.0035

// Camera: zoom out as score grows; cap by ~30k score (smoothstep).
const ZOOM_SCORE_SOFT = 40
const ZOOM_SCORE_CAP = 30000
const ZOOM_MAX = 1
const ZOOM_MIN = 0.42

function zoomFromScore(score) {
  const s = Math.max(0, score)
  if (s <= ZOOM_SCORE_SOFT) return ZOOM_MAX
  if (s >= ZOOM_SCORE_CAP) return ZOOM_MIN
  const t = (s - ZOOM_SCORE_SOFT) / (ZOOM_SCORE_CAP - ZOOM_SCORE_SOFT)
  const u = t * t * (3 - 2 * t)
  return ZOOM_MAX - u * (ZOOM_MAX - ZOOM_MIN)
}

/** Visible world AABB (for culling + minimap viewport) when centered on (meX, meY). */
function worldViewBounds(meX, meY, screenW, screenH, zoom) {
  const vw = screenW / zoom
  const vh = screenH / zoom
  return {
    left: meX - vw / 2,
    right: meX + vw / 2,
    top: meY - vh / 2,
    bottom: meY + vh / 2,
    vw,
    vh,
  }
}

const PLAYER_NAMES = [
  'Arndt', 'Barfuss', 'Belles', 'Bellerose', 'Bernstein', 'Brennan',
  'Bronson', 'DenHann', 'Flanagan', 'Groesbeck', 'Hunsaker', 'Jones',
  'K Miller', 'Kenner', 'Kirby', 'Kroon', 'Lampe', 'Leimer',
  'Miller', 'Morrison', 'Nooren', 'Paice', 'Rashid', 'Rodriguez',
  'Siegrist', 'Simon', 'Smith', 'Stafford', 'Worgull', 'Wylie',
]
const COLORS = ['#f97316', '#a855f7', '#ec4899', '#3b82f6', '#84cc16', '#14b8a6']
const SEA_CREATURES = ['🐠', '🦈', '🐙', '🦑', '🐡', '🦞', '🦀', '🐬', '🦭', '🦐', '🐟', '🐋']
const creatureMap = {} // player id -> creature, assigned on first sight
function getCreature(id) {
  if (!creatureMap[id]) {
    creatureMap[id] = SEA_CREATURES[Object.keys(creatureMap).length % SEA_CREATURES.length]
  }
  return creatureMap[id]
}

// ---- Audio helpers ----
function playNote(ctx, freq, duration, vol = 0.15, type = 'triangle') {
  const osc = ctx.createOscillator()
  const gain = ctx.createGain()
  osc.type = type
  osc.frequency.value = freq
  gain.gain.setValueAtTime(0, ctx.currentTime)
  gain.gain.linearRampToValueAtTime(vol, ctx.currentTime + 0.01)
  gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + duration)
  osc.connect(gain)
  gain.connect(ctx.destination)
  osc.start()
  osc.stop(ctx.currentTime + duration)
}

function playPelletSound(ctx) {
  // Quick bright pop
  playNote(ctx, 700 + Math.random() * 400, 0.12, 0.4, 'sine')
}

function playEatPlayerSound(ctx) {
  // Satisfying descending gulp
  const osc = ctx.createOscillator()
  const gain = ctx.createGain()
  osc.type = 'sawtooth'
  osc.frequency.setValueAtTime(280, ctx.currentTime)
  osc.frequency.exponentialRampToValueAtTime(55, ctx.currentTime + 0.45)
  gain.gain.setValueAtTime(0.75, ctx.currentTime)
  gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.45)
  osc.connect(gain)
  gain.connect(ctx.destination)
  osc.start()
  osc.stop(ctx.currentTime + 0.45)
  // Extra punch layer
  playNote(ctx, 160, 0.2, 0.55, 'square')
}

// Tropical steel-drum melody: pentatonic C major C D E G A
const PENTA = [261.63, 293.66, 329.63, 392.00, 440.00, 523.25, 587.33, 659.25]
const MELODY = [4,2,5,3,4,6,5,4, 2,3,4,2,1,3,2,0]
const BASS   = [0,0,1,1, 0,0,2,1] // indices into [C2,G2,F2]
const BASS_NOTES = [65.41, 98.00, 87.31]

function playWave(ctx) {
  const duration = 3.5 + Math.random() * 2
  const bufLen = Math.floor(ctx.sampleRate * duration)
  const buf = ctx.createBuffer(1, bufLen, ctx.sampleRate)
  const data = buf.getChannelData(0)
  for (let i = 0; i < bufLen; i++) data[i] = Math.random() * 2 - 1

  const src = ctx.createBufferSource()
  src.buffer = buf

  // Low-pass to get that whooshy ocean rumble
  const lp = ctx.createBiquadFilter()
  lp.type = 'lowpass'
  lp.frequency.value = 420
  lp.frequency.linearRampToValueAtTime(180, ctx.currentTime + duration)

  const gain = ctx.createGain()
  // Swell in, hold, fade out
  gain.gain.setValueAtTime(0, ctx.currentTime)
  gain.gain.linearRampToValueAtTime(0.55, ctx.currentTime + duration * 0.35)
  gain.gain.setValueAtTime(0.55, ctx.currentTime + duration * 0.6)
  gain.gain.linearRampToValueAtTime(0, ctx.currentTime + duration)

  src.connect(lp)
  lp.connect(gain)
  gain.connect(ctx.destination)
  src.start()
  src.stop(ctx.currentTime + duration)
}

function playDolphin(ctx) {
  // Dolphins: rapid bursts of high-pitched chirps and clicks
  const numClicks = 3 + Math.floor(Math.random() * 5)
  let offset = 0
  for (let i = 0; i < numClicks; i++) {
    const isChirp = Math.random() > 0.4
    if (isChirp) {
      // Chirp: fast upward or downward sweep
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      const goUp = Math.random() > 0.5
      osc.type = 'sine'
      osc.frequency.setValueAtTime(goUp ? 1800 + Math.random() * 600 : 3200 + Math.random() * 800, ctx.currentTime + offset)
      osc.frequency.exponentialRampToValueAtTime(goUp ? 3400 + Math.random() * 800 : 1600 + Math.random() * 400, ctx.currentTime + offset + 0.12)
      gain.gain.setValueAtTime(0, ctx.currentTime + offset)
      gain.gain.linearRampToValueAtTime(0.22, ctx.currentTime + offset + 0.02)
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + offset + 0.12)
      osc.connect(gain)
      gain.connect(ctx.destination)
      osc.start(ctx.currentTime + offset)
      osc.stop(ctx.currentTime + offset + 0.13)
      offset += 0.1 + Math.random() * 0.15
    } else {
      // Click: very short noise burst
      const bufLen = Math.floor(ctx.sampleRate * 0.015)
      const buf = ctx.createBuffer(1, bufLen, ctx.sampleRate)
      const data = buf.getChannelData(0)
      for (let j = 0; j < bufLen; j++) data[j] = (Math.random() * 2 - 1) * (1 - j / bufLen)
      const src = ctx.createBufferSource()
      src.buffer = buf
      const hp = ctx.createBiquadFilter()
      hp.type = 'highpass'
      hp.frequency.value = 2000
      const gain = ctx.createGain()
      gain.gain.value = 0.28
      src.connect(hp)
      hp.connect(gain)
      gain.connect(ctx.destination)
      src.start(ctx.currentTime + offset)
      offset += 0.04 + Math.random() * 0.06
    }
  }
}

function playWhale(ctx) {
  // Whales sing long sweeping glides — randomise each call slightly
  const calls = [
    { start: 180, end: 80,  dur: 2.2 },
    { start: 90,  end: 160, dur: 1.8 },
    { start: 120, end: 60,  dur: 2.8 },
    { start: 70,  end: 140, dur: 2.0 },
  ]
  const sequence = Array.from({ length: 2 + Math.floor(Math.random() * 3) }, () =>
    calls[Math.floor(Math.random() * calls.length)]
  )

  let offset = 0
  for (const call of sequence) {
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    // Slight vibrato
    const lfo = ctx.createOscillator()
    const lfoGain = ctx.createGain()
    lfo.frequency.value = 3 + Math.random() * 2
    lfoGain.gain.value = 4
    lfo.connect(lfoGain)
    lfoGain.connect(osc.frequency)

    osc.type = 'sine'
    osc.frequency.setValueAtTime(call.start, ctx.currentTime + offset)
    osc.frequency.exponentialRampToValueAtTime(call.end, ctx.currentTime + offset + call.dur)

    gain.gain.setValueAtTime(0, ctx.currentTime + offset)
    gain.gain.linearRampToValueAtTime(0.25, ctx.currentTime + offset + call.dur * 0.2)
    gain.gain.setValueAtTime(0.25, ctx.currentTime + offset + call.dur * 0.75)
    gain.gain.linearRampToValueAtTime(0, ctx.currentTime + offset + call.dur)

    osc.connect(gain)
    gain.connect(ctx.destination)
    lfo.start(ctx.currentTime + offset)
    osc.start(ctx.currentTime + offset)
    lfo.stop(ctx.currentTime + offset + call.dur)
    osc.stop(ctx.currentTime + offset + call.dur)

    offset += call.dur + 0.3 + Math.random() * 0.5
  }
}

function startOceanSounds(ctx, mutedRef) {
  const timeouts = []

  function scheduleWave() {
    const t = setTimeout(() => {
      if (!mutedRef.current) playWave(ctx)
      timeouts.push(scheduleWave())
    }, 4000 + Math.random() * 5000)
    return t
  }

  function scheduleWhale() {
    const t = setTimeout(() => {
      if (!mutedRef.current) playWhale(ctx)
      timeouts.push(scheduleWhale())
    }, 3000 + Math.random() * 5000) // every 3–8s
    return t
  }

  function scheduleDolphin() {
    const t = setTimeout(() => {
      if (!mutedRef.current) playDolphin(ctx)
      timeouts.push(scheduleDolphin())
    }, 2000 + Math.random() * 4000) // every 2–6s
    return t
  }

  timeouts.push(scheduleWave())
  // Three whales staggered at start so it's immediately lively
  if (!mutedRef.current) playWhale(ctx)
  timeouts.push(setTimeout(() => { if (!mutedRef.current) playWhale(ctx) }, 2000))
  timeouts.push(setTimeout(() => { if (!mutedRef.current) playWhale(ctx) }, 4500))
  timeouts.push(scheduleWhale())
  // Dolphins start after a moment
  timeouts.push(setTimeout(() => { if (!mutedRef.current) playDolphin(ctx) }, 1000))
  timeouts.push(scheduleDolphin())

  return () => timeouts.forEach(clearTimeout)
}

function startMusic(ctx, mutedRef) {
  let beat = 0
  const bps = 0.28 // seconds per beat (~214 BPM, upbeat tropical)
  const id = setInterval(() => {
    if (mutedRef.current) { beat++; return }
    // Melody
    playNote(ctx, PENTA[MELODY[beat % MELODY.length]], bps * 0.85, 0.04, 'triangle')
    // Bass every 2 beats
    if (beat % 2 === 0) {
      playNote(ctx, BASS_NOTES[BASS[Math.floor(beat / 2) % BASS.length]], bps * 1.8, 0.06, 'sine')
    }
    // Hi-hat every beat
    const hh = ctx.createBufferSource()
    const buf = ctx.createBuffer(1, ctx.sampleRate * 0.04, ctx.sampleRate)
    const data = buf.getChannelData(0)
    for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / data.length)
    hh.buffer = buf
    const hhGain = ctx.createGain()
    hhGain.gain.value = 0.015
    hh.connect(hhGain)
    hhGain.connect(ctx.destination)
    hh.start()
    beat++
  }, bps * 1000)
  return id
}

function makePellets() {
  const pellets = []
  for (let i = 0; i < MOCK_MAX_PELLETS; i++) {
    const n = pellets.filter(p => p.kind === 'normal').length
    const g = pellets.filter(p => p.kind === 'gold').length
    const gold = g < Math.floor(n / MOCK_NORMALS_PER_GOLD)
    if (gold) {
      const sp = 3 + Math.random() * 3
      const a = Math.random() * Math.PI * 2
      pellets.push({
        id: i,
        x: Math.random() * MAP_SIZE,
        y: Math.random() * MAP_SIZE,
        radius: MOCK_GOLD_RADIUS,
        color: '#fbbf24',
        kind: 'gold',
        imgIdx: Math.floor(Math.random() * 2),
        vx: Math.cos(a) * sp,
        vy: Math.sin(a) * sp,
      })
    } else {
      const stationary = Math.random() < 0.45
      let vx = 0
      let vy = 0
      if (!stationary) {
        const s = 0.1 + Math.random() * 0.15
        const a = Math.random() * Math.PI * 2
        vx = Math.cos(a) * s
        vy = Math.sin(a) * s
      }
      pellets.push({
        id: i,
        x: Math.random() * MAP_SIZE,
        y: Math.random() * MAP_SIZE,
        radius: MOCK_PELLET_RADIUS,
        color: COLORS[Math.floor(Math.random() * COLORS.length)],
        kind: 'normal',
        vx,
        vy,
      })
    }
  }
  return pellets
}

function mockSpawnOnePellet(pellets) {
  const n = pellets.filter(p => p.kind === 'normal').length
  const g = pellets.filter(p => p.kind === 'gold').length
  const gold = g < Math.floor(n / MOCK_NORMALS_PER_GOLD)
  if (gold) {
    const sp = 3 + Math.random() * 3
    const a = Math.random() * Math.PI * 2
    return {
      id: Date.now() + Math.random(),
      x: Math.random() * MAP_SIZE,
      y: Math.random() * MAP_SIZE,
      radius: MOCK_GOLD_RADIUS,
      color: '#fbbf24',
      kind: 'gold',
      imgIdx: Math.floor(Math.random() * 2),
      vx: Math.cos(a) * sp,
      vy: Math.sin(a) * sp,
    }
  }
  const stationary = Math.random() < 0.45
  let vx = 0
  let vy = 0
  if (!stationary) {
    const s = 0.1 + Math.random() * 0.15
    const a = Math.random() * Math.PI * 2
    vx = Math.cos(a) * s
    vy = Math.sin(a) * s
  }
  return {
    id: Date.now() + Math.random(),
    x: Math.random() * MAP_SIZE,
    y: Math.random() * MAP_SIZE,
    radius: MOCK_PELLET_RADIUS,
    color: COLORS[Math.floor(Math.random() * COLORS.length)],
    kind: 'normal',
    vx,
    vy,
  }
}

export default function App() {
  const [screen, setScreen] = useState('picker') // picker | login | game | dead
  const [playerName, setPlayerName] = useState(loadPlayerNameFromStorage)
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
  const audioCtxRef = useRef(null)
  const musicLoopRef = useRef(null)
  const stopOceanRef = useRef(null)
  const [muted, setMuted] = useState(true)
  const mutedRef = useRef(true)
  const [deathLeaderboard, setDeathLeaderboard] = useState([])
  const [serverOnline, setServerOnline] = useState(true)
  const disconnectTimer = useRef(null)
  const [showHint, setShowHint] = useState(false)
  const bubblesRef = useRef([])

  useEffect(() => {
    if (screen !== 'game') bubblesRef.current = []
  }, [screen])

  // Show control hint for 15s when game starts
  useEffect(() => {
    if (screen !== 'game') { setShowHint(false); return }
    setShowHint(true)
    const t = setTimeout(() => setShowHint(false), 15000)
    return () => clearTimeout(t)
  }, [screen])

  // Ping server every 3s on login screen to check if online
  useEffect(() => {
    if (screen !== 'login') return
    let active = true
    function ping() {
      fetch(API_URL + '/socket.io/?EIO=4&transport=polling', { mode: 'cors' })
        .then(r => { if (active) setServerOnline(r.ok) })
        .catch(() => { if (active) setServerOnline(false) })
    }
    ping()
    const id = setInterval(ping, 3000)
    return () => { active = false; clearInterval(id) }
  }, [screen])

  // Kick back to login if disconnected for 3+ seconds during game
  useEffect(() => {
    if (MOCK_MODE) return
    socket.on('disconnect', () => {
      disconnectTimer.current = setTimeout(() => {
        setScreen('login')
        socket.disconnect()
      }, 3000)
    })
    socket.on('connect', () => {
      if (disconnectTimer.current) {
        clearTimeout(disconnectTimer.current)
        disconnectTimer.current = null
      }
    })
    return () => {
      socket.off('disconnect')
      socket.off('connect')
      if (disconnectTimer.current) clearTimeout(disconnectTimer.current)
    }
  }, [])

  function getAudio() {
    if (!audioCtxRef.current) {
      audioCtxRef.current = new (window.AudioContext || window.webkitAudioContext)()
    }
    if (!mutedRef.current && audioCtxRef.current.state === 'suspended') {
      void audioCtxRef.current.resume()
    }
    return audioCtxRef.current
  }

  useEffect(() => { mutedRef.current = muted }, [muted])

  // Keep playerNameRef in sync + persist (alphanumeric only, max 15)
  useEffect(() => {
    playerNameRef.current = effectivePlayerName(playerName)
    localStorage.setItem('playerName', sanitizePlayerNameInput(playerName))
  }, [playerName])

  // Preload player avatars
  useEffect(() => {
    const img = new Image()
    img.src = '/player1.jpeg'
    img.onload = () => { avatarImgRef.current = img }
  }, [])

  // Small pellets: logo. Gold (large) pellets: Adam / Nathan faces (indexed 0/1).
  const pelletLogoRef = useRef(null)
  const pelletFaceImgsRef = useRef([null, null])
  useEffect(() => {
    const logo = new Image()
    logo.src = '/logo.jpg'
    logo.onload = () => { pelletLogoRef.current = logo }
    ;['/adam.jpg', '/nathan.jpg'].forEach((src, i) => {
      const img = new Image()
      img.src = src
      img.onload = () => { pelletFaceImgsRef.current[i] = img }
    })
  }, [])

  // Music + ocean: only while in-game and unmuted; suspend Web Audio when muted so nothing plays.
  useEffect(() => {
    if (screen !== 'game') {
      if (musicLoopRef.current != null) {
        clearInterval(musicLoopRef.current)
        musicLoopRef.current = null
      }
      if (stopOceanRef.current) {
        stopOceanRef.current()
        stopOceanRef.current = null
      }
      return
    }
    if (muted) {
      if (musicLoopRef.current != null) {
        clearInterval(musicLoopRef.current)
        musicLoopRef.current = null
      }
      if (stopOceanRef.current) {
        stopOceanRef.current()
        stopOceanRef.current = null
      }
      if (audioCtxRef.current?.state === 'running') {
        void audioCtxRef.current.suspend()
      }
      return
    }

    const ctx = getAudio()
    if (ctx.state === 'suspended') void ctx.resume()

    if (musicLoopRef.current != null) clearInterval(musicLoopRef.current)
    if (stopOceanRef.current) {
      stopOceanRef.current()
      stopOceanRef.current = null
    }

    const id = startMusic(ctx, mutedRef)
    musicLoopRef.current = id
    stopOceanRef.current = startOceanSounds(ctx, mutedRef)

    return () => {
      clearInterval(id)
      if (stopOceanRef.current) {
        stopOceanRef.current()
        stopOceanRef.current = null
      }
    }
  }, [screen, muted])

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
      const state = gameStateRef.current
      const sorted = [...state.players].sort((a, b) => b.score - a.score)
      setDeathLeaderboard(sorted.map(p => ({ name: p.name, score: p.score, id: p.id })))
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

    const MOCK_HENRY_SCORE_MULT = 3

    const ha = Math.random() * Math.PI * 2
    const hm = MOCK_HENRY_FIXED_RADIUS + 60
    const henry = {
      id: 'henry-bot',
      name: 'HenryaBOT',
      x: hm + Math.random() * (MAP_SIZE - hm * 2),
      y: hm + Math.random() * (MAP_SIZE - hm * 2),
      radius: MOCK_HENRY_FIXED_RADIUS,
      color: '#f59e0b',
      score: 5000,
      dx: Math.cos(ha),
      dy: Math.sin(ha),
      henrySpeed: 17 + Math.random() * 3,
      isHenry: true,
    }

    const bots = Array.from({ length: 4 }, (_, i) => ({
      id: `bot-${i}`,
      name: PLAYER_NAMES[i + 1] || `Bot ${i + 1}`,
      x: Math.random() * MAP_SIZE,
      y: Math.random() * MAP_SIZE,
      radius: 15 + Math.random() * 25,
      color: COLORS[i % COLORS.length],
      score: 0,
      vx: (Math.random() - 0.5) * 3,
      vy: (Math.random() - 0.5) * 3,
      isHenry: false,
    }))

    const me = {
      id: 'mock-player',
      name: effectivePlayerName(playerName),
      x: MAP_SIZE / 2,
      y: MAP_SIZE / 2,
      radius: 20,
      color: '#0ea5e9',
      score: 0,
      isHenry: false,
    }

    myIdRef.current = 'mock-player'
    gameStateRef.current = { players: [me, henry, ...bots], pellets: makePellets() }

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

      // Henry: wall bounce + periodic random steer (same idea as server)
      const h = state.players.find(p => p.id === 'henry-bot')
      if (h) {
        h.x += h.dx * h.henrySpeed
        h.y += h.dy * h.henrySpeed
        const r = h.radius
        if (h.x < r) {
          h.x = r
          h.dx *= -1
        } else if (h.x > MAP_SIZE - r) {
          h.x = MAP_SIZE - r
          h.dx *= -1
        }
        if (h.y < r) {
          h.y = r
          h.dy *= -1
        } else if (h.y > MAP_SIZE - r) {
          h.y = MAP_SIZE - r
          h.dy *= -1
        }
        if (Math.random() < MOCK_HENRY_RANDOM_STEER) {
          const a = Math.random() * Math.PI * 2
          h.dx = Math.cos(a)
          h.dy = Math.sin(a)
        }
      }

      // Pellet drift (match server feel)
      for (const pellet of state.pellets) {
        if (pellet.kind === 'gold') {
          if (Math.random() < 0.03) {
            const sp = 3 + Math.random() * 3
            const a = Math.random() * Math.PI * 2
            pellet.vx = Math.cos(a) * sp
            pellet.vy = Math.sin(a) * sp
          }
        } else if ((pellet.vx || pellet.vy) && Math.random() < 0.04) {
          pellet.vx += (Math.random() - 0.5) * 0.06
          pellet.vy += (Math.random() - 0.5) * 0.06
          const len = Math.hypot(pellet.vx, pellet.vy)
          if (len > 0.25) {
            const s = 0.25 / len
            pellet.vx *= s
            pellet.vy *= s
          }
        }
        pellet.x += pellet.vx
        pellet.y += pellet.vy
        const rad = pellet.radius
        if (pellet.kind === 'gold') {
          if (pellet.x < rad) { pellet.x = rad; pellet.vx *= -1 }
          else if (pellet.x > MAP_SIZE - rad) { pellet.x = MAP_SIZE - rad; pellet.vx *= -1 }
          if (pellet.y < rad) { pellet.y = rad; pellet.vy *= -1 }
          else if (pellet.y > MAP_SIZE - rad) { pellet.y = MAP_SIZE - rad; pellet.vy *= -1 }
          pellet.vx += (Math.random() - 0.5) * 1.2
          pellet.vy += (Math.random() - 0.5) * 1.2
          const len = Math.hypot(pellet.vx, pellet.vy)
          if (len > 1e-6) {
            const sp = 3 + Math.random() * 3
            pellet.vx = (pellet.vx / len) * sp
            pellet.vy = (pellet.vy / len) * sp
          }
        } else if (pellet.vx || pellet.vy) {
          if (pellet.x < rad) { pellet.x = rad; pellet.vx *= -1 }
          else if (pellet.x > MAP_SIZE - rad) { pellet.x = MAP_SIZE - rad; pellet.vx *= -1 }
          if (pellet.y < rad) { pellet.y = rad; pellet.vy *= -1 }
          else if (pellet.y > MAP_SIZE - rad) { pellet.y = MAP_SIZE - rad; pellet.vy *= -1 }
          pellet.vx += (Math.random() - 0.5) * 0.04
          pellet.vy += (Math.random() - 0.5) * 0.04
          const len2 = Math.hypot(pellet.vx, pellet.vy)
          if (len2 > 0.25) {
            const s = 0.25 / len2
            pellet.vx *= s
            pellet.vy *= s
          }
        }
      }

      // Move bots (wander + bounce off walls)
      for (const bot of state.players.filter(p => p.id !== 'mock-player' && !p.isHenry)) {
        bot.x += bot.vx
        bot.y += bot.vy
        if (bot.x < bot.radius || bot.x > MAP_SIZE - bot.radius) bot.vx *= -1
        if (bot.y < bot.radius || bot.y > MAP_SIZE - bot.radius) bot.vy *= -1
        bot.x = Math.max(bot.radius, Math.min(MAP_SIZE - bot.radius, bot.x))
        bot.y = Math.max(bot.radius, Math.min(MAP_SIZE - bot.radius, bot.y))
      }

      // Eat players — score determines winner, not visual radius
      for (let i = 0; i < state.players.length; i++) {
        const eater = state.players[i]
        for (let j = 0; j < state.players.length; j++) {
          if (i === j) continue
          const prey = state.players[j]
          const dx = eater.x - prey.x
          const dy = eater.y - prey.y
          const dist = Math.sqrt(dx * dx + dy * dy)
          if (eater.score > prey.score * 1.1 && dist < eater.radius && !prey.isHenry) {
            const gain = Math.floor(prey.score / 2)
            eater.score += eater.isHenry ? Math.ceil(gain * MOCK_HENRY_SCORE_MULT) : gain
            if (eater.isHenry) {
              const a = Math.random() * Math.PI * 2
              eater.dx = Math.cos(a)
              eater.dy = Math.sin(a)
            }
            if (!eater.isHenry) {
              eater.radius = Math.sqrt(eater.radius ** 2 + prey.radius ** 2)
            }
            if (eater.id === 'mock-player') {
              setMyScore(eater.score)
              if (!mutedRef.current) playEatPlayerSound(getAudio())
            }
            if (prey.id === 'mock-player') {
              setKilledBy(eater.name)
              setScreen('dead')
              return
            } else {
              prey.x = Math.random() * MAP_SIZE
              prey.y = Math.random() * MAP_SIZE
              prey.radius = 15 + Math.random() * 10
              prey.score = 0
            }
          }
        }
      }

      // Eat pellets
      let ateAPellet = false
      state.pellets = state.pellets.filter(pellet => {
        for (const p of state.players) {
          const dx = p.x - pellet.x
          const dy = p.y - pellet.y
          if (Math.sqrt(dx * dx + dy * dy) < p.radius + pellet.radius) {
            let gain = pellet.kind === 'gold' ? MOCK_GOLD_SCORE : MOCK_PELLET_SCORE
            if (p.isHenry) gain = Math.ceil(gain * MOCK_HENRY_PELLET_MULT)
            p.score += gain
            if (p.isHenry) {
              const a = Math.random() * Math.PI * 2
              p.dx = Math.cos(a)
              p.dy = Math.sin(a)
            }
            if (!p.isHenry) p.radius += 1
            if (p.id === 'mock-player') {
              setMyScore(p.score)
              ateAPellet = true
            }
            return false
          }
        }
        return true
      })
      if (ateAPellet && !mutedRef.current) playPelletSound(getAudio())

      // Respawn pellets
      while (state.pellets.length < MOCK_MAX_PELLETS) {
        state.pellets.push(mockSpawnOnePellet(state.pellets))
      }
    }, 1000 / 30)

    return () => clearInterval(interval)
  }, [screen])

  // Handle play
  const handlePlay = useCallback(() => {
    if (!muted) getAudio() // user gesture + only if sound on
    const name = effectivePlayerName(playerName)
    if (MOCK_MODE) {
      setMyScore(0)
      setScreen('game')
      return
    }
    if (!socket.connected) socket.connect()
    socket.emit('login', { name })
  }, [playerName, muted])

  // Handle restart
  const handleRestart = useCallback(() => {
    if (!muted) getAudio()
    if (MOCK_MODE) {
      setMyScore(0)
      setScreen('game')
      return
    }
    socket.emit('restart')
  }, [muted])

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

      const zoom = zoomFromScore(me.score)
      const invZ = 1 / zoom
      const vb = worldViewBounds(me.x, me.y, w, h, zoom)

      ctx.save()
      ctx.translate(w / 2, h / 2)
      ctx.scale(zoom, zoom)
      ctx.translate(-me.x, -me.y)

      // Water inside map
      ctx.fillStyle = '#67e8f9'
      ctx.fillRect(0, 0, MAP_SIZE, MAP_SIZE)

      // Subtle checkerboard water pattern — batch all rects into one fill call
      const gridSize = 80
      const startX = Math.floor(Math.max(0, vb.left) / gridSize) * gridSize
      const endX = Math.min(MAP_SIZE, vb.right + gridSize)
      const startY = Math.floor(Math.max(0, vb.top) / gridSize) * gridSize
      const endY = Math.min(MAP_SIZE, vb.bottom + gridSize)
      ctx.beginPath()
      for (let x = startX; x < endX; x += gridSize) {
        for (let y = startY; y < endY; y += gridSize) {
          if (((x / gridSize) + (y / gridSize)) % 2 === 0) {
            ctx.rect(x, y, gridSize, gridSize)
          }
        }
      }
      ctx.fillStyle = 'rgba(14, 165, 233, 0.18)'
      ctx.fill()

      // Sandy beach border (compensate line width so it stays ~similar px when zoomed out)
      ctx.strokeStyle = '#f59e0b'
      ctx.lineWidth = Math.min(28, Math.max(10, 20 * invZ))
      ctx.strokeRect(0, 0, MAP_SIZE, MAP_SIZE)
      ctx.strokeStyle = '#fcd34d'
      ctx.lineWidth = Math.min(12, Math.max(4, 6 * invZ))
      ctx.strokeRect(0, 0, MAP_SIZE, MAP_SIZE)

      // Bubble trail behind you (world coords; r / lineWidth scaled by invZ so ~constant screen size when zoomed out)
      if (me && Math.random() < 0.55) {
        const pxR = 3.5 + Math.random() * 5.5
        bubblesRef.current.push({
          x: me.x + (Math.random() - 0.5) * me.radius * 0.65,
          y: me.y + me.radius * 0.42,
          r: pxR * invZ,
          life: 1,
        })
      }
      const bubbles = bubblesRef.current
      let bWrite = 0
      for (let i = 0; i < bubbles.length; i++) {
        bubbles[i].life -= 0.024
        if (bubbles[i].life > 0) bubbles[bWrite++] = bubbles[i]
      }
      bubbles.length = Math.min(bWrite, 56)
      const bubbleStroke = Math.max(1, 2.4 * invZ)
      for (const b of bubbles) {
        const a = Math.min(0.95, 0.2 + b.life * 0.55)
        ctx.beginPath()
        ctx.arc(b.x, b.y, b.r, 0, Math.PI * 2)
        ctx.fillStyle = `rgba(255,255,255,${a * 0.22})`
        ctx.fill()
        ctx.strokeStyle = `rgba(255,255,255,${a * 0.75})`
        ctx.lineWidth = bubbleStroke
        ctx.stroke()
      }

      // Pellets — small: logo.jpg; gold (large): Adam or Nathan face + gold rings
      const logoImg = pelletLogoRef.current
      const faceImgs = pelletFaceImgsRef.current
      const pulse = 0.5 + 0.5 * Math.sin(performance.now() / 220)
      const PELLET_DRAW_MULT = 3
      for (const pellet of state.pellets) {
        const isGold = pellet.kind === 'gold'
        const pr = pellet.radius * PELLET_DRAW_MULT
        const px = pellet.x
        const py = pellet.y

        const glowPad = 12 * invZ
        if (px < vb.left - pr - glowPad || px > vb.right + pr + glowPad) continue
        if (py < vb.top - pr - glowPad || py > vb.bottom + pr + glowPad) continue

        const idx = pellet.imgIdx != null ? pellet.imgIdx : (pellet.id % 2)
        const clipImg = isGold
          ? faceImgs[idx % 2]
          : logoImg
        if (clipImg) {
          ctx.save()
          ctx.beginPath()
          ctx.arc(px, py, pr, 0, Math.PI * 2)
          ctx.clip()
          const d = pr * 2
          ctx.drawImage(clipImg, px - pr, py - pr, d, d)
          ctx.restore()
        } else {
          ctx.beginPath()
          ctx.arc(px, py, pr, 0, Math.PI * 2)
          const grd = ctx.createRadialGradient(
            px - pr * 0.35, py - pr * 0.35, 0,
            px, py, pr
          )
          if (isGold) {
            grd.addColorStop(0, '#fff7c2')
            grd.addColorStop(0.45, '#fbbf24')
            grd.addColorStop(1, '#b45309')
          } else {
            grd.addColorStop(0, pellet.color)
            grd.addColorStop(1, pellet.color)
          }
          ctx.fillStyle = grd
          ctx.fill()
        }
        ctx.beginPath()
        ctx.arc(px, py, pr, 0, Math.PI * 2)
        ctx.strokeStyle = isGold ? `rgba(253, 224, 71, ${0.55 + pulse * 0.35})` : 'rgba(255,255,255,0.5)'
        ctx.lineWidth = isGold ? 2.2 : 1.5
        ctx.stroke()
        if (isGold) {
          ctx.beginPath()
          ctx.arc(px, py, pr + 5 + pulse * 2, 0, Math.PI * 2)
          ctx.strokeStyle = `rgba(250, 204, 21, ${0.25 + pulse * 0.2})`
          ctx.lineWidth = 1.5
          ctx.stroke()
        }
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
          ctx.lineWidth = Math.min(5, Math.max(1.5, 2.5 * invZ))
          ctx.stroke()
          ctx.setLineDash([])
          ctx.restore()
        }

        // Golden glow for Henry (no shadowBlur — too expensive; stroke ring only)
        if (player.isHenry) {
          ctx.beginPath()
          ctx.arc(player.x, player.y, player.radius + 4, 0, Math.PI * 2)
          ctx.strokeStyle = `rgba(250, 204, 21, ${0.5 + pulse * 0.3})`
          ctx.lineWidth = 3
          ctx.stroke()
        }

        // Blob
        const usePhoto = player.isHenry && avatarImgRef.current
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
        ctx.strokeStyle = player.isHenry ? 'rgba(250, 204, 21, 0.7)' : 'rgba(255,255,255,0.6)'
        ctx.lineWidth = Math.min(6, Math.max(1.5, 3 * invZ))
        ctx.stroke()

        if (!usePhoto) {
          // Sea creature emoji
          const emojiSize = Math.max(12, player.radius * 1.1)
          ctx.font = `${emojiSize}px serif`
          ctx.textAlign = 'center'
          ctx.textBaseline = 'middle'
          ctx.fillText(getCreature(player.id), player.x, player.y)

          // Shine spot
          ctx.beginPath()
          ctx.arc(
            player.x - player.radius * 0.28,
            player.y - player.radius * 0.28,
            player.radius * 0.22, 0, Math.PI * 2
          )
          ctx.fillStyle = 'rgba(255,255,255,0.35)'
          ctx.fill()
        }

        // Name under each player
        const displayName = isMe
          ? (String(player.name || '').trim() || effectivePlayerName(playerNameRef.current) || 'Player')
          : ((player.name && String(player.name).trim()) || 'Player')
        const nameSize = Math.min(72, Math.max(8, player.radius * 0.4))
        ctx.font = `bold ${nameSize}px Quicksand, sans-serif`
        ctx.textAlign = 'center'
        ctx.textBaseline = 'top'
        const nameX = Math.round(player.x)
        const nameY = Math.round(player.y + player.radius + 4)
        if (player.isHenry) {
          ctx.fillStyle = '#fbbf24'
          ctx.strokeStyle = 'rgba(0,0,0,0.5)'
        } else {
          ctx.fillStyle = 'rgba(255,255,255,0.95)'
          ctx.strokeStyle = 'rgba(0,0,0,0.55)'
        }
        ctx.lineWidth = Math.max(2, nameSize * 0.11)
        ctx.strokeText(displayName, nameX, nameY)
        ctx.fillText(displayName, nameX, nameY)

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

      // Top 3 leaderboard (top-right)
      const sorted = [...state.players].sort((a, b) => b.score - a.score).slice(0, 3)
      const lbX = w - 14, lbY = 14
      ctx.textAlign = 'right'
      ctx.textBaseline = 'top'
      ctx.font = 'bold 15px Quicksand, sans-serif'
      ctx.fillStyle = 'rgba(255,255,255,0.85)'
      ctx.beginPath()
      ctx.roundRect(lbX - 170, lbY, 170, 18 + sorted.length * 22, 12)
      ctx.fill()
      ctx.fillStyle = '#0369a1'
      ctx.font = 'bold 14px Quicksand, sans-serif'
      ctx.fillText('Leaderboard', lbX - 10, lbY + 4)
      sorted.forEach((p, i) => {
        const medal = i === 0 ? '1.' : i === 1 ? '2.' : '3.'
        const isMe = p.id === myIdRef.current
        ctx.font = isMe ? 'bold 13px Quicksand, sans-serif' : '13px Quicksand, sans-serif'
        ctx.fillStyle = isMe ? '#f59e0b' : '#0369a1'
        ctx.fillText(`${medal} ${p.name}  ${p.score}`, lbX - 10, lbY + 20 + i * 22)
      })

      // Online players count (top-left, below score)
      ctx.textAlign = 'left'
      ctx.textBaseline = 'top'
      const onlineText = `Online: ${state.players.length}`
      const ow = ctx.measureText(onlineText).width
      ctx.fillStyle = 'rgba(255,255,255,0.85)'
      ctx.beginPath()
      ctx.roundRect(12, 56, ow + 28, 32, 16)
      ctx.fill()
      ctx.font = 'bold 15px Quicksand, sans-serif'
      ctx.fillStyle = '#0369a1'
      ctx.fillText(onlineText, 26, 64)

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
        const baseR = player.radius * mmScale
        const dotR = player.id === myIdRef.current
          ? Math.max(2.5, Math.min(baseR * 1.08, mmSize * 0.42))
          : Math.max(1.4, Math.min(baseR, mmSize * 0.4))
        ctx.beginPath()
        ctx.arc(mmX + player.x * mmScale, mmY + player.y * mmScale, dotR, 0, Math.PI * 2)
        ctx.fillStyle = player.id === myIdRef.current ? '#f59e0b' : player.color
        ctx.fill()
      }

      ctx.strokeStyle = 'rgba(0,0,0,0.35)'
      ctx.lineWidth = 1
      ctx.strokeRect(
        mmX + vb.left * mmScale,
        mmY + vb.top * mmScale,
        vb.vw * mmScale,
        vb.vh * mmScale
      )

      animFrameRef.current = requestAnimationFrame(draw)
    }

    animFrameRef.current = requestAnimationFrame(draw)

    return () => {
      window.removeEventListener('resize', resize)
      if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current)
    }
  }, [screen])

  // Mouse + touch movement (same aim: direction from screen center)
  useEffect(() => {
    if (screen !== 'game') return

    function emitFromPoint(clientX, clientY) {
      const cx = window.innerWidth / 2
      const cy = window.innerHeight / 2
      const dx = clientX - cx
      const dy = clientY - cy
      mouseDirRef.current = { x: dx, y: dy }

      if (!MOCK_MODE) {
        const now = Date.now()
        if (now - lastEmitRef.current < 33) return
        lastEmitRef.current = now
        const me = gameStateRef.current.players.find(p => p.id === myIdRef.current)
        if (me) {
          const zoom = zoomFromScore(me.score)
          socket.emit('playerMove', {
            x: dx, y: dy,
            cx: me.x, cy: me.y,
            zoom, sw: window.innerWidth, sh: window.innerHeight,
          })
        } else {
          socket.emit('playerMove', { x: dx, y: dy })
        }
      }
    }

    function handleMouseMove(e) {
      emitFromPoint(e.clientX, e.clientY)
    }

    function handleTouch(e) {
      if (e.touches.length === 0) return
      const t = e.touches[0]
      emitFromPoint(t.clientX, t.clientY)
    }

    window.addEventListener('mousemove', handleMouseMove)
    window.addEventListener('touchmove', handleTouch, { passive: true })
    window.addEventListener('touchstart', handleTouch, { passive: true })
    return () => {
      window.removeEventListener('mousemove', handleMouseMove)
      window.removeEventListener('touchmove', handleTouch)
      window.removeEventListener('touchstart', handleTouch)
    }
  }, [screen])

  // ---- Render ----
  if (screen === 'picker') {
    return (
      <div className="game-picker-screen">
        <div className="game-picker-bg" aria-hidden />
        <header className="game-picker-header">
          <h1 className="game-picker-title">Netgain Arcade</h1>
          <p className="game-picker-sub">Pick a game — more landing here over time</p>
        </header>
        <div className="game-picker-grid">
          {GAME_CATALOG.map((g, i) => (
            <button
              key={g.id}
              type="button"
              className={`game-tile ${g.ready ? 'game-tile--ready' : 'game-tile--soon'}`}
              style={{ animationDelay: `${i * 0.07}s` }}
              disabled={!g.ready}
              onClick={() => {
                if (!g.ready) return
                if (g.id === 'netgame') setScreen('login')
              }}
            >
              {g.ready ? (
                <>
                  <span className="game-tile-icon">{g.icon}</span>
                  <span className="game-tile-title">{g.title}</span>
                  <span className="game-tile-blurb">{g.blurb}</span>
                </>
              ) : (
                <span className="game-tile-title game-tile-title--placeholder">Placeholder</span>
              )}
            </button>
          ))}
        </div>
      </div>
    )
  }

  if (screen === 'login') {
    return (
      <div className="login-screen">
        <button type="button" className="back-to-picker" onClick={() => setScreen('picker')}>
          ← All games
        </button>
        <h1 className="game-title">NetGame</h1>
        <p className="game-subtitle">Eat or be eaten</p>
        {MOCK_MODE && <p className="mock-badge">⚠ Mock Mode — no server needed</p>}
        <input
          type="text"
          className="name-input"
          value={playerName}
          onChange={e => setPlayerName(sanitizePlayerNameInput(e.target.value))}
          maxLength={PLAYER_NAME_MAX}
          placeholder="Name (A–Z, 0–9)"
          autoComplete="off"
          spellCheck={false}
          aria-label="Player name"
        />
        <button className="play-btn" onClick={handlePlay} disabled={!serverOnline && !MOCK_MODE}>Play</button>
        {!serverOnline && !MOCK_MODE && <div className="server-offline-banner">Server Offline</div>}
        <p className="login-credits">Created By: Nick Kenner & Andrew Stafford</p>
      </div>
    )
  }

  if (screen === 'dead') {
    return (
      <div className="dead-screen">
        <h1 className="dead-title">GAME OVER</h1>
        <p className="dead-info">Eaten by <span className="killer-name">{killedBy}</span></p>
        <p className="dead-score">Final score: {myScore}</p>
        {deathLeaderboard.length > 0 && (() => {
          const top10 = deathLeaderboard.slice(0, 10)
          const myRank = deathLeaderboard.findIndex(p => p.id === myIdRef.current)
          const inTop10 = myRank >= 0 && myRank < 10
          return (
            <div className="death-leaderboard">
              <h2 className="lb-title">Leaderboard</h2>
              {top10.map((p, i) => (
                <div key={p.id} className={`lb-row ${p.id === myIdRef.current ? 'lb-me' : ''}`}>
                  <span className="lb-rank">#{i + 1}</span>
                  <span className="lb-name">{p.name}</span>
                  <span className="lb-score">{p.score}</span>
                </div>
              ))}
              {!inTop10 && myRank >= 0 && (
                <>
                  <div className="lb-divider">...</div>
                  <div className="lb-row lb-me">
                    <span className="lb-rank">#{myRank + 1}</span>
                    <span className="lb-name">{deathLeaderboard[myRank].name}</span>
                    <span className="lb-score">{deathLeaderboard[myRank].score}</span>
                  </div>
                </>
              )}
            </div>
          )
        })()}
        <button className="play-btn" onClick={handleRestart}>Play Again</button>
      </div>
    )
  }

  const isMobile = 'ontouchstart' in window || navigator.maxTouchPoints > 0

  return (
    <div style={{ position: 'relative' }}>
      <canvas ref={canvasRef} className="game-canvas" />
      <button className="mute-btn mute-bottom-left" onClick={() => setMuted(m => !m)}>
        {muted ? '🔇' : '🔊'}
      </button>
      {showHint && (
        <div className="control-hint">
          {isMobile ? 'Tap screen to change direction' : 'Move mouse to change direction'}
        </div>
      )}
    </div>
  )
}
