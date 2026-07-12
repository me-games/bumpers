import './style.css'
import * as THREE from 'three'
import { connect, type Session } from '@genex-ai/multiplayer'
import { GENEX } from './genex.config'
import { RemoteInterpolator } from './interpolation'

type Role = 'champion' | 'challenger' | 'waiting' | 'spectator'
type Phase = 'waiting' | 'playing' | 'between'

type PlayerNetState = {
  x: number
  y: number
  z: number
  vx: number
  vz: number
  yaw: number
  color: string
  joinedAt: number
  roundId: number
}

type MatchState = {
  version: number
  authorityId: string
  phase: Phase
  roundId: number
  championId: string | null
  challengerId: string | null
  winnerId: string | null
  loserId: string | null
  nextRoundAt: number
  message: string
  scores: Record<string, number>
}

type LocalBall = PlayerNetState & {
  dirtyResetRound: number
}

type BallVisual = {
  root: THREE.Group
  sphere: THREE.Mesh<THREE.SphereGeometry, THREE.MeshStandardMaterial>
  ring: THREE.Mesh<THREE.TorusGeometry, THREE.MeshStandardMaterial>
  label: HTMLDivElement
  lastPos: THREE.Vector3
}

const app = query<HTMLDivElement>('#app')

app.innerHTML = `
  <canvas id="game"></canvas>
  <div id="hud">
    <div id="status">
      <span id="role">Connecting</span>
      <strong id="headline">Joining the arena...</strong>
      <span id="detail">Arrow keys or WASD roll your ball. Push the other ball over the edge.</span>
    </div>
    <div id="scoreboard">
      <div><span>Champion</span><strong id="championName">-</strong></div>
      <div><span>Challenger</span><strong id="challengerName">-</strong></div>
      <div><span>Waiting</span><strong id="waitingCount">0</strong></div>
    </div>
  </div>
  <div id="nameTags"></div>
`

const canvas = query<HTMLCanvasElement>('#game')
const roleEl = query<HTMLSpanElement>('#role')
const headlineEl = query<HTMLElement>('#headline')
const detailEl = query<HTMLSpanElement>('#detail')
const championNameEl = query<HTMLElement>('#championName')
const challengerNameEl = query<HTMLElement>('#challengerName')
const waitingCountEl = query<HTMLElement>('#waitingCount')
const nameTags = query<HTMLDivElement>('#nameTags')

const ARENA_SIZE = 18
const HALF_ARENA = ARENA_SIZE / 2
const BALL_RADIUS = 0.72
const OUT_LIMIT = HALF_ARENA + BALL_RADIUS * 0.55
const SPAWN_Z = 4.6
const MAX_SPEED = 7.4
const ACCEL = 16.5
const FRICTION = 0.9
const BALL_RESTITUTION = 0.82
const ROUND_DELAY_MS = 3000

const keys = new Set<string>()
const visuals = new Map<string, BallVisual>()
const interp = new RemoteInterpolator()
const raycaster = new THREE.Raycaster()
const pointer = new THREE.Vector2()
const worldPoint = new THREE.Vector3()
const floorPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0)

const playerName = `${getStoredName()}-${Math.floor(10 + Math.random() * 90)}`
const playerColor = getStoredColor()
const joinedAt = Date.now() + Math.random()
const local: LocalBall = {
  x: 0,
  y: BALL_RADIUS,
  z: 0,
  vx: 0,
  vz: 0,
  yaw: 0,
  color: playerColor,
  joinedAt,
  roundId: 0,
  dirtyResetRound: -1,
}

const scene = new THREE.Scene()
scene.background = new THREE.Color(0x101318)
scene.fog = new THREE.Fog(0x101318, 20, 43)

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true })
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
renderer.shadowMap.enabled = true
renderer.shadowMap.type = THREE.PCFShadowMap

const camera = new THREE.PerspectiveCamera(46, 1, 0.1, 100)
camera.position.set(0, 15.5, 16.5)
camera.lookAt(0, 0, 0)

const hemi = new THREE.HemisphereLight(0xdfeeff, 0x27321f, 2.3)
scene.add(hemi)

const sun = new THREE.DirectionalLight(0xffffff, 3.6)
sun.position.set(-7, 14, 8)
sun.castShadow = true
sun.shadow.mapSize.set(2048, 2048)
sun.shadow.camera.near = 1
sun.shadow.camera.far = 36
sun.shadow.camera.left = -14
sun.shadow.camera.right = 14
sun.shadow.camera.top = 14
sun.shadow.camera.bottom = -14
scene.add(sun)

const arena = createArena()
scene.add(arena)

let room: Session<PlayerNetState> | null = null
let currentMatch: MatchState = defaultMatch('')
let lastKnownRound = -1
let publishTimer: number | null = null
let authorityTimer: number | null = null
let lastFrameAt = performance.now()
let connectError = ''

window.addEventListener('keydown', (event) => {
  if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'KeyW', 'KeyA', 'KeyS', 'KeyD', 'Space'].includes(event.code)) {
    event.preventDefault()
    keys.add(event.code)
  }
})

window.addEventListener('keyup', (event) => {
  keys.delete(event.code)
})

window.addEventListener('pointermove', (event) => {
  const bounds = canvas.getBoundingClientRect()
  pointer.x = ((event.clientX - bounds.left) / bounds.width) * 2 - 1
  pointer.y = -(((event.clientY - bounds.top) / bounds.height) * 2 - 1)
})

window.addEventListener('resize', resize)
resize()

start().catch((error: unknown) => {
  connectError = error instanceof Error ? error.message : 'Could not connect.'
  roleEl.textContent = 'Offline'
  headlineEl.textContent = 'The arena is running locally.'
  detailEl.textContent = 'The online room did not connect. Try reloading in a moment.'
})

requestAnimationFrame(frame)

async function start() {
  room = await connect<PlayerNetState>({
    urls: [GENEX.colyseusUrl],
    room: GENEX.slug,
    name: playerName,
  })

  room.on('leave', (id) => {
    removeVisual(id)
    interp.remove(id)
  })

  publishTimer = window.setInterval(() => {
    if (!room) return
    room.me.set({
      x: local.x,
      y: local.y,
      z: local.z,
      vx: local.vx,
      vz: local.vz,
      yaw: local.yaw,
      color: local.color,
      joinedAt: local.joinedAt,
      roundId: local.roundId,
    })
  }, 66)

  authorityTimer = window.setInterval(runAuthority, 250)
}

function frame() {
  const now = performance.now()
  const dt = Math.min(0.035, (now - lastFrameAt) / 1000 || 0.016)
  lastFrameAt = now

  readSharedMatch()
  const activeRole = getMyRole()
  applyRoundReset(activeRole)
  stepLocal(dt, activeRole)
  drawPlayers()
  updateHud(activeRole)
  renderer.render(scene, camera)
  requestAnimationFrame(frame)
}

function stepLocal(dt: number, role: Role) {
  const active = role === 'champion' || role === 'challenger'
  if (!active || currentMatch.phase !== 'playing') {
    local.vx *= Math.pow(0.2, dt)
    local.vz *= Math.pow(0.2, dt)
    local.x += local.vx * dt
    local.z += local.vz * dt
    return
  }

  let ix = 0
  let iz = 0
  if (keys.has('ArrowLeft') || keys.has('KeyA')) ix -= 1
  if (keys.has('ArrowRight') || keys.has('KeyD')) ix += 1
  if (keys.has('ArrowUp') || keys.has('KeyW')) iz -= 1
  if (keys.has('ArrowDown') || keys.has('KeyS')) iz += 1

  const inputLength = Math.hypot(ix, iz) || 1
  ix /= inputLength
  iz /= inputLength

  local.vx += ix * ACCEL * dt
  local.vz += iz * ACCEL * dt
  if (keys.has('Space')) {
    local.vx *= Math.pow(0.18, dt)
    local.vz *= Math.pow(0.18, dt)
  }

  const speed = Math.hypot(local.vx, local.vz)
  if (speed > MAX_SPEED) {
    local.vx = (local.vx / speed) * MAX_SPEED
    local.vz = (local.vz / speed) * MAX_SPEED
  }

  local.x += local.vx * dt
  local.z += local.vz * dt
  collideWithOpponent()
  local.vx *= Math.pow(FRICTION, dt)
  local.vz *= Math.pow(FRICTION, dt)

  const moveSpeed = Math.hypot(local.vx, local.vz)
  if (moveSpeed > 0.05) local.yaw = Math.atan2(local.vx, local.vz)
}

function collideWithOpponent() {
  if (!room) return
  const opponentId = getOpponentId()
  if (!opponentId) return
  const opponent = room.players.get(opponentId)
  if (!opponent) return
  const state = opponent.stateRaw
  const dx = local.x - safeNumber(state.x, 0)
  const dz = local.z - safeNumber(state.z, 0)
  const dist = Math.hypot(dx, dz)
  const minDist = BALL_RADIUS * 2
  if (dist <= 0.001 || dist >= minDist) return

  const nx = dx / dist
  const nz = dz / dist
  const overlap = minDist - dist
  local.x += nx * overlap * 0.5
  local.z += nz * overlap * 0.5

  const rvx = local.vx - safeNumber(state.vx, 0)
  const rvz = local.vz - safeNumber(state.vz, 0)
  const impact = rvx * nx + rvz * nz
  if (impact < 0) {
    const impulse = -(1 + BALL_RESTITUTION) * impact * 0.7
    local.vx += nx * impulse
    local.vz += nz * impulse
  } else {
    local.vx += nx * overlap * 1.8
    local.vz += nz * overlap * 1.8
  }
}

function applyRoundReset(role: Role) {
  if (currentMatch.roundId === local.dirtyResetRound) return
  local.dirtyResetRound = currentMatch.roundId
  if (role !== 'champion' && role !== 'challenger') return

  const side = role === 'champion' ? -1 : 1
  local.x = 0
  local.y = BALL_RADIUS
  local.z = side * SPAWN_Z
  local.vx = 0
  local.vz = 0
  local.yaw = role === 'champion' ? 0 : Math.PI
  local.roundId = currentMatch.roundId
}

function drawPlayers() {
  if (!room) {
    const visual = visualFor('local', local.color)
    applyVisual(visual, local, true, 'You')
    return
  }

  removeVisual('local')
  const liveIds = new Set<string>()
  const players = room.players
  for (const [id, player] of players) {
    const visual = visualFor(id, String(player.stateRaw.color || '#e8ecf3'))
    liveIds.add(id)
    if (id === room.id) {
      applyVisual(visual, local, true, playerName)
      continue
    }
    const raw = player.stateRaw
    interp.push(id, {
      x: safeNumber(raw.x, 0),
      y: safeNumber(raw.y, BALL_RADIUS),
      z: safeNumber(raw.z, 0),
      yaw: safeNumber(raw.yaw, 0),
    })
    const sample = interp.sample(id)
    applyVisual(
      visual,
      {
        x: sample?.x ?? safeNumber(player.state.x, 0),
        y: sample?.y ?? safeNumber(player.state.y, BALL_RADIUS),
        z: sample?.z ?? safeNumber(player.state.z, 0),
        vx: safeNumber(player.state.vx, 0),
        vz: safeNumber(player.state.vz, 0),
        yaw: sample?.yaw ?? safeNumber(player.state.yaw, 0),
        color: String(player.stateRaw.color || '#e8ecf3'),
        joinedAt: safeNumber(player.stateRaw.joinedAt, 0),
        roundId: safeNumber(player.stateRaw.roundId, 0),
      },
      isActiveId(id),
      displayName(id),
    )
  }

  for (const id of visuals.keys()) {
    if (!liveIds.has(id) && id !== 'local') removeVisual(id)
  }
}

function applyVisual(visual: BallVisual, state: PlayerNetState, active: boolean, label: string) {
  visual.root.position.set(state.x, state.y, state.z)
  visual.root.rotation.y = state.yaw
  visual.ring.visible = active
  visual.ring.rotation.z += 0.045

  const delta = visual.lastPos.distanceTo(visual.root.position)
  if (delta > 0.0001) {
    visual.sphere.rotation.x += (state.z - visual.lastPos.z) / BALL_RADIUS
    visual.sphere.rotation.z -= (state.x - visual.lastPos.x) / BALL_RADIUS
    visual.lastPos.copy(visual.root.position)
  }

  visual.label.textContent = label
  visual.label.classList.toggle('active', active)
  updateLabelPosition(visual)
}

function updateLabelPosition(visual: BallVisual) {
  const p = visual.root.position.clone()
  p.y += 1.25
  p.project(camera)
  const visible = p.z < 1
  visual.label.style.display = visible ? 'block' : 'none'
  if (!visible) return
  visual.label.style.transform = `translate(-50%, -50%) translate(${((p.x + 1) / 2) * window.innerWidth}px, ${((-p.y + 1) / 2) * window.innerHeight}px)`
}

function runAuthority() {
  if (!room) return
  const ids = Array.from(room.players.keys()).sort()
  if (ids[0] !== room.id) return

  const players = Array.from(room.players.values())
    .filter((player) => player.stateRaw && Number.isFinite(player.stateRaw.joinedAt))
    .sort((a, b) => safeNumber(a.stateRaw.joinedAt, 0) - safeNumber(b.stateRaw.joinedAt, 0))

  const previous = readMatchValue()
  const now = Date.now()
  const scores = { ...(previous?.scores ?? {}) }
  const present = new Set(players.map((player) => player.id))
  let championId = previous?.championId && present.has(previous.championId) ? previous.championId : null
  let challengerId = previous?.challengerId && present.has(previous.challengerId) ? previous.challengerId : null
  let phase: Phase = previous?.phase ?? 'waiting'
  let winnerId = previous?.winnerId ?? null
  let loserId = previous?.loserId ?? null
  let roundId = previous?.roundId ?? 0
  let nextRoundAt = previous?.nextRoundAt ?? 0
  let message = previous?.message ?? 'Waiting for players.'

  if (players.length === 0) return

  if (!championId) {
    championId = players[0].id
    challengerId = null
    phase = 'waiting'
    winnerId = null
    loserId = null
    message = 'Waiting for a challenger.'
  }

  if (championId && challengerId === championId) challengerId = null

  const nextWaiting = players.find((player) => player.id !== championId && player.id !== challengerId)

  if (!challengerId && nextWaiting) {
    challengerId = nextWaiting.id
    phase = 'playing'
    winnerId = null
    loserId = null
    roundId += 1
    nextRoundAt = 0
    message = 'Push the other ball out.'
  }

  if (!challengerId) {
    phase = 'waiting'
    winnerId = null
    loserId = null
    message = 'Waiting for a challenger.'
  }

  if (phase === 'playing' && championId && challengerId) {
    const champion = room.players.get(championId)
    const challenger = room.players.get(challengerId)
    const championOut = isOut(champion?.stateRaw)
    const challengerOut = isOut(challenger?.stateRaw)
    if (championOut || challengerOut) {
      winnerId = championOut && !challengerOut ? challengerId : championId
      loserId = winnerId === championId ? challengerId : championId
      scores[winnerId] = (scores[winnerId] ?? 0) + 1
      phase = 'between'
      nextRoundAt = now + ROUND_DELAY_MS
      message = `${displayName(winnerId)} stays in.`
    }
  }

  if (phase === 'between' && nextRoundAt > 0 && now >= nextRoundAt) {
    championId = winnerId && present.has(winnerId) ? winnerId : players[0].id
    challengerId = null
    const challenger =
      players.find((player) => player.id !== championId && player.id !== loserId) ??
      players.find((player) => player.id !== championId)
    if (challenger) {
      challengerId = challenger.id
      phase = 'playing'
      roundId += 1
      winnerId = null
      loserId = null
      nextRoundAt = 0
      message = 'Next challenger is in.'
    } else {
      phase = 'waiting'
      winnerId = null
      loserId = null
      nextRoundAt = 0
      message = 'Winner is waiting for a challenger.'
    }
  }

  const next: MatchState = {
    version: 1,
    authorityId: room.id,
    phase,
    roundId,
    championId,
    challengerId,
    winnerId,
    loserId,
    nextRoundAt,
    message,
    scores,
  }

  if (JSON.stringify(previous) !== JSON.stringify(next)) room.shared.set('match', next)
}

function readSharedMatch() {
  const value = readMatchValue()
  if (!value) {
    currentMatch = defaultMatch(room?.id ?? '')
    return
  }
  currentMatch = value
  if (currentMatch.roundId !== lastKnownRound) lastKnownRound = currentMatch.roundId
}

function readMatchValue(): MatchState | null {
  if (!room) return null
  const value = room.shared.get('match')
  if (!isRecord(value)) return null
  return {
    version: safeNumber(value.version, 1),
    authorityId: typeof value.authorityId === 'string' ? value.authorityId : '',
    phase: parsePhase(value.phase),
    roundId: safeNumber(value.roundId, 0),
    championId: typeof value.championId === 'string' ? value.championId : null,
    challengerId: typeof value.challengerId === 'string' ? value.challengerId : null,
    winnerId: typeof value.winnerId === 'string' ? value.winnerId : null,
    loserId: typeof value.loserId === 'string' ? value.loserId : null,
    nextRoundAt: safeNumber(value.nextRoundAt, 0),
    message: typeof value.message === 'string' ? value.message : 'Waiting for players.',
    scores: parseScores(value.scores),
  }
}

function updateHud(role: Role) {
  const players = room?.players ?? new Map<string, { id: string; name: string; state: PlayerNetState; stateRaw: PlayerNetState }>()
  const waiting = Array.from(players.keys()).filter((id) => !isActiveId(id)).length

  roleEl.textContent = roleLabel(role)
  championNameEl.textContent = currentMatch.championId ? displayName(currentMatch.championId) : '-'
  challengerNameEl.textContent = currentMatch.challengerId ? displayName(currentMatch.challengerId) : '-'
  waitingCountEl.textContent = String(waiting)

  if (connectError) {
    headlineEl.textContent = 'The online room is unavailable.'
    detailEl.textContent = connectError
    return
  }

  if (!room) {
    headlineEl.textContent = 'Joining the arena...'
    detailEl.textContent = 'You will enter the queue once connected.'
    return
  }

  if (currentMatch.phase === 'waiting') {
    headlineEl.textContent = role === 'champion' ? 'You are holding the floor.' : 'Waiting for a second ball.'
    detailEl.textContent = 'Share the game with someone else to start the duel.'
    return
  }

  if (currentMatch.phase === 'between') {
    headlineEl.textContent = currentMatch.winnerId === room.id ? 'You stay in.' : `${displayName(currentMatch.winnerId)} stays in.`
    detailEl.textContent = 'The next challenger enters in a moment.'
    return
  }

  if (role === 'champion' || role === 'challenger') {
    headlineEl.textContent = 'Push the other ball out.'
    detailEl.textContent = 'Use WASD or arrows. Space slows you down for control.'
  } else {
    headlineEl.textContent = 'Watching this round.'
    detailEl.textContent = waiting > 0 ? 'You are in the waiting line for the next open challenger spot.' : 'The winner stays. The next player joins after the round.'
  }
}

function createArena() {
  const group = new THREE.Group()

  const floorGeo = new THREE.BoxGeometry(ARENA_SIZE, 0.34, ARENA_SIZE)
  const floorMat = new THREE.MeshStandardMaterial({
    color: 0x2b7468,
    roughness: 0.72,
    metalness: 0.05,
  })
  const floor = new THREE.Mesh(floorGeo, floorMat)
  floor.receiveShadow = true
  floor.position.y = -0.18
  group.add(floor)

  const grid = new THREE.GridHelper(ARENA_SIZE, 12, 0xd3f4c6, 0x6aa398)
  grid.position.y = 0.012
  group.add(grid)

  const railMat = new THREE.MeshStandardMaterial({
    color: 0xe6c35a,
    roughness: 0.46,
    metalness: 0.12,
  })
  const railGeoLong = new THREE.BoxGeometry(ARENA_SIZE + 0.45, 0.08, 0.22)
  const railGeoShort = new THREE.BoxGeometry(0.22, 0.08, ARENA_SIZE + 0.45)

  for (const z of [-HALF_ARENA - 0.24, HALF_ARENA + 0.24]) {
    const rail = new THREE.Mesh(railGeoLong, railMat)
    rail.position.set(0, 0.06, z)
    rail.castShadow = true
    rail.receiveShadow = true
    group.add(rail)
  }

  for (const x of [-HALF_ARENA - 0.24, HALF_ARENA + 0.24]) {
    const rail = new THREE.Mesh(railGeoShort, railMat)
    rail.position.set(x, 0.06, 0)
    rail.castShadow = true
    rail.receiveShadow = true
    group.add(rail)
  }

  const pitGeo = new THREE.BoxGeometry(ARENA_SIZE + 8, 0.1, ARENA_SIZE + 8)
  const pitMat = new THREE.MeshStandardMaterial({ color: 0x171b23, roughness: 0.9 })
  const pit = new THREE.Mesh(pitGeo, pitMat)
  pit.position.y = -0.95
  pit.receiveShadow = true
  group.add(pit)

  return group
}

function visualFor(id: string, color: string) {
  const existing = visuals.get(id)
  if (existing) {
    existing.sphere.material.color.set(color)
    return existing
  }

  const root = new THREE.Group()
  const sphereGeo = new THREE.SphereGeometry(BALL_RADIUS, 48, 32)
  const sphereMat = new THREE.MeshStandardMaterial({
    color,
    roughness: 0.38,
    metalness: 0.08,
  })
  const sphere = new THREE.Mesh(sphereGeo, sphereMat)
  sphere.castShadow = true
  sphere.receiveShadow = true
  root.add(sphere)

  const stripeGeo = new THREE.TorusGeometry(BALL_RADIUS * 1.02, 0.025, 8, 72)
  const stripeMat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.35,
    metalness: 0.02,
  })
  const stripe = new THREE.Mesh(stripeGeo, stripeMat)
  stripe.rotation.x = Math.PI / 2
  root.add(stripe)

  const ringGeo = new THREE.TorusGeometry(BALL_RADIUS * 1.42, 0.035, 8, 80)
  const ringMat = new THREE.MeshStandardMaterial({
    color: 0xf4d35e,
    emissive: 0x6d4a10,
    emissiveIntensity: 0.8,
    roughness: 0.4,
  })
  const ring = new THREE.Mesh(ringGeo, ringMat)
  ring.position.y = -BALL_RADIUS * 0.8
  ring.rotation.x = Math.PI / 2
  root.add(ring)

  const label = document.createElement('div')
  label.className = 'nameTag'
  nameTags.append(label)

  scene.add(root)
  const visual = { root, sphere, ring, label, lastPos: new THREE.Vector3() }
  visuals.set(id, visual)
  return visual
}

function removeVisual(id: string) {
  const visual = visuals.get(id)
  if (!visual) return
  scene.remove(visual.root)
  visual.root.traverse((child) => {
    if (child instanceof THREE.Mesh) {
      child.geometry.dispose()
      const material = child.material
      if (Array.isArray(material)) material.forEach((m) => m.dispose())
      else material.dispose()
    }
  })
  visual.label.remove()
  visuals.delete(id)
}

function getMyRole(): Role {
  if (!room) return 'spectator'
  if (currentMatch.championId === room.id) return 'champion'
  if (currentMatch.challengerId === room.id) return 'challenger'
  return currentMatch.phase === 'playing' ? 'spectator' : 'waiting'
}

function getOpponentId() {
  if (!room) return null
  if (currentMatch.championId === room.id) return currentMatch.challengerId
  if (currentMatch.challengerId === room.id) return currentMatch.championId
  return null
}

function isActiveId(id: string) {
  return id === currentMatch.championId || id === currentMatch.challengerId
}

function displayName(id: string | null) {
  if (!id) return '-'
  if (room?.id === id) return 'You'
  return room?.players.get(id)?.name || `Ball ${id.slice(0, 4)}`
}

function roleLabel(role: Role) {
  if (role === 'champion') return 'Champion'
  if (role === 'challenger') return 'Challenger'
  if (role === 'waiting') return 'Waiting'
  return 'Watching'
}

function isOut(state: PlayerNetState | undefined) {
  if (!state) return true
  return Math.abs(safeNumber(state.x, 0)) > OUT_LIMIT || Math.abs(safeNumber(state.z, 0)) > OUT_LIMIT
}

function defaultMatch(authorityId: string): MatchState {
  return {
    version: 1,
    authorityId,
    phase: 'waiting',
    roundId: 0,
    championId: null,
    challengerId: null,
    winnerId: null,
    loserId: null,
    nextRoundAt: 0,
    message: 'Waiting for players.',
    scores: {},
  }
}

function parsePhase(value: unknown): Phase {
  return value === 'playing' || value === 'between' || value === 'waiting' ? value : 'waiting'
}

function parseScores(value: unknown): Record<string, number> {
  if (!isRecord(value)) return {}
  const scores: Record<string, number> = {}
  for (const [key, score] of Object.entries(value)) scores[key] = safeNumber(score, 0)
  return scores
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function safeNumber(value: unknown, fallback: number) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function query<T extends Element>(selector: string) {
  const element = document.querySelector<T>(selector)
  if (!element) throw new Error(`Missing ${selector}`)
  return element
}

function resize() {
  const width = window.innerWidth
  const height = window.innerHeight
  renderer.setSize(width, height, false)
  camera.aspect = width / height
  camera.updateProjectionMatrix()
}

function getStoredName() {
  const stored = localStorage.getItem('bumpers:name')
  if (stored) return stored
  const name = `Ball ${Math.floor(1000 + Math.random() * 9000)}`
  localStorage.setItem('bumpers:name', name)
  return name
}

function getStoredColor() {
  const stored = localStorage.getItem('bumpers:color')
  if (stored) return stored
  const palette = ['#e84f5f', '#33a1fd', '#f6c85f', '#54c6a0', '#b875ff', '#ff8a4c']
  const color = palette[Math.floor(Math.random() * palette.length)]
  localStorage.setItem('bumpers:color', color)
  return color
}

function updatePointerWorld() {
  raycaster.setFromCamera(pointer, camera)
  raycaster.ray.intersectPlane(floorPlane, worldPoint)
  return worldPoint
}

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) lastFrameAt = performance.now()
})

window.addEventListener('beforeunload', () => {
  if (publishTimer !== null) window.clearInterval(publishTimer)
  if (authorityTimer !== null) window.clearInterval(authorityTimer)
  room?.leave()
})

updatePointerWorld()
