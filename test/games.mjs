// Game-script e2e under the mock widget host: uploads the four-in-a-row
// and chess examples (fresh room each) and plays them through real
// pointer input - seat claiming, a disc drop landing in the right cell,
// and a legal pawn double-step DRAGGED to its square, easing into the
// center and flipping the turn. Chess move legality is also probed
// negatively (dragging to an illegal square must ease the piece home).
// Run the dev server first: npm run dev
import { chromium } from 'playwright'
import { readFileSync } from 'node:fs'

const base = process.env.URL ?? 'http://localhost:5173'
const browser = await chromium.launch({ headless: false })
const ctx = await browser.newContext({ viewport: { width: 1500, height: 900 } })

function fail(msg) {
  console.error('FAIL:', msg)
  process.exitCode = 1
}

async function open(name) {
  const page = await ctx.newPage()
  page.on('pageerror', (e) => console.error(`${name} pageerror:`, String(e).slice(0, 200)))
  await page.goto(`${base}/mock.html?room=${name}${Math.random().toString(36).slice(2, 8)}`)
  await page.waitForFunction(() => {
    const f = document.getElementById('widget')
    const w = f && f.contentWindow
    return !!(w && w.__jig && w.__jig.session && w.__jig.session.ready())
  }, null, { timeout: 30000 })
  const frame = page.frames().find((f) => f !== page.mainFrame())
  const bb = await (await page.$('#widget')).boundingBox()
  return { page, frame, bb }
}

const props = (f) => f.evaluate(() => window.__jig.props())
const near = (a, b, eps = 0.05) => Math.abs(a - b) < eps
const findProp = (list, x, y, z) => list.find((p) => near(p.x, x) && near(p.y, y) && near(p.z, z))

async function clickProp(t, id) {
  const s = await t.frame.evaluate((id) => window.__jig.screenOfProp(id), id)
  if (!s) throw new Error(`prop ${id} has no screen position`)
  await t.page.mouse.click(t.bb.x + s.x, t.bb.y + s.y)
  await t.page.waitForTimeout(600) // let the ops fold
}

async function uploadScript(t, path, name) {
  await t.frame.setInputFiles('#scriptfile', { name, mimeType: 'text/javascript', buffer: readFileSync(path) })
  const ok = await t.frame.waitForFunction(
    () => [...document.querySelectorAll('#log div')].some((d) => d.textContent.includes('world script running')),
    null, { timeout: 20000 }).then(() => true).catch(() => false)
  if (!ok) throw new Error(`${name} never started`)
}

// --- four-in-a-row ---
{
  const t = await open('c4')
  await uploadScript(t, 'examples/four-in-a-row.js', 'four-in-a-row.js')
  const seeded = await t.frame.waitForFunction(
    () => window.__jig.props().length >= 9, null, { timeout: 15000 }).then(() => true).catch(() => false)
  if (!seeded) fail('c4: seats/selectors never seeded')
  await t.page.waitForTimeout(1200) // camera + fold settle
  let ps = await props(t.frame)
  const redSeat = ps.find((p) => p.color === 0xda664f && near(p.y, 0.6))
  if (!redSeat) fail(`c4: no red seat in ${JSON.stringify(ps)}`)
  await clickProp(t, redSeat.id)
  ps = await props(t.frame)
  if (!ps.find((p) => p.id === redSeat.id).claim) fail('c4: red seat claim did not land')

  const sel3 = findProp(ps, (3 - 3) * 0.8, 5.7, 0)
  if (!sel3) fail('c4: no column-3 selector')
  await clickProp(t, sel3.id)
  await t.page.waitForTimeout(1500)
  ps = await props(t.frame)
  const disc = findProp(ps, 0, 0.9, 0)
  if (!disc || disc.color !== 0xda664f) fail(`c4: red disc did not land in col 3 row 0`)

  // yellow's turn: same peer claims the other seat and drops on top
  const yelSeat = ps.find((p) => p.color === 0xe3db50 && near(p.y, 0.6))
  await clickProp(t, yelSeat.id)
  await clickProp(t, sel3.id)
  await t.page.waitForTimeout(1500)
  ps = await props(t.frame)
  const disc2 = findProp(ps, 0, 1.7, 0)
  if (!disc2 || disc2.color !== 0xe3db50) fail('c4: yellow disc did not stack in col 3 row 1')
  if (process.exitCode !== 1) console.log('four-in-a-row: seats, turn order and drops work')
  await t.page.close()
}

// --- chess ---
{
  const t = await open('ch')
  await uploadScript(t, 'examples/chess.js', 'chess.js')
  const BOARD_Y = 0.02, LIFT = 0.5
  // press the piece at its base (the near-steal pick grabs it there), pull
  // the pointer to the target square on the LIFT drag plane, release
  async function dragTo(fromX, fromZ, toX, toZ) {
    const s = await t.frame.evaluate(([x, y, z]) => window.__jig.screenOfWorld(x, y, z), [fromX, BOARD_Y, fromZ])
    const e = await t.frame.evaluate(([x, y, z]) => window.__jig.screenOfWorld(x, y, z), [toX, LIFT, toZ])
    await t.page.mouse.move(t.bb.x + s.x, t.bb.y + s.y)
    await t.page.mouse.down()
    for (let i = 1; i <= 8; i++) {
      await t.page.mouse.move(t.bb.x + s.x + ((e.x - s.x) * i) / 8, t.bb.y + s.y + ((e.y - s.y) * i) / 8)
      await t.page.waitForTimeout(50)
    }
    await t.page.mouse.up()
    await t.page.waitForTimeout(1000) // let the ops fold and the ease land
  }
  // staged seeding: 64 tiles, then furniture, then 32 piece props (and no
  // physics cubes: the modelled pieces ARE the game)
  const seeded = await t.frame.waitForFunction((y) => {
    const ps = window.__jig.props()
    const pieces = ps.filter((p) => Math.abs(p.y - y) < 0.05)
    return ps.length >= 99 && pieces.length === 32
  }, BOARD_Y, { timeout: 30000 }).then(() => true).catch(() => false)
  if (!seeded) fail('chess: board never fully seeded')
  const cubes = await t.frame.evaluate(() => window.__jig.sim.bodies.size)
  if (cubes !== 0) fail(`chess: expected no physics cubes, got ${cubes}`)
  await t.page.waitForTimeout(1200)

  let ps = await props(t.frame)
  const sqX = (c) => (c - 3.5) * 1.2, sqZ = (r) => (3.5 - r) * 1.2
  const whiteSeat = ps.find((p) => p.color === 0xf3ead6 && near(p.y, 0.6))
  if (!whiteSeat) fail('chess: no white seat')
  await clickProp(t, whiteSeat.id)
  ps = await props(t.frame)
  if (!ps.find((p) => p.id === whiteSeat.id).claim) fail('chess: white seat claim did not land')

  const pawn = findProp(ps, sqX(4), BOARD_Y, sqZ(1)) // e2
  if (!pawn) fail('chess: no pawn on e2')

  // negative probe: dragging to an illegal square (e5, three ahead) must
  // ease the pawn back home
  await dragTo(sqX(4), sqZ(1), sqX(4), sqZ(4))
  ps = await props(t.frame)
  if (!findProp(ps, sqX(4), BOARD_Y, sqZ(1))) fail('chess: pawn stuck after an ILLEGAL drag')

  // legal double-step: drag e2 -> e4, released mid-square it must ease
  // into the center
  await dragTo(sqX(4), sqZ(1), sqX(4), sqZ(3))
  ps = await props(t.frame)
  if (!findProp(ps, sqX(4), BOARD_Y, sqZ(3))) fail('chess: pawn did not reach e4')
  const turn = ps.find((p) => near(p.y, 1.4) && near(p.x, 6.2))
  if (!turn || turn.color !== 0x241d16) fail('chess: turn sphere did not flip to black')
  // the mover narrates the move into the room as themselves (world.say),
  // in standard algebraic notation: a pawn double-step is just 'e4'
  const said = await t.frame.evaluate(() =>
    window.__jig.net.client.getRooms().flatMap((r) => r.timeline ?? [])
      .some((ev) => ev.getType() === 'm.room.message' && ev.getContent().body === 'e4'))
  if (!said) fail('chess: move was not announced as SAN in the room')

  // capture: claim black too (solo testing), reply d5, take exd5 - the
  // captured black pawn must ease off to white's graveyard on the -x
  // side (the taker's left), not despawn
  const blackSeat = ps.find((p) => p.color === 0x241d16 && near(p.y, 0.6))
  await clickProp(t, blackSeat.id)
  await t.page.waitForTimeout(1000) // localLatch between moves
  await dragTo(sqX(3), sqZ(6), sqX(3), sqZ(4)) // d7 -> d5
  await t.page.waitForTimeout(1000)
  await dragTo(sqX(4), sqZ(3), sqX(3), sqZ(4)) // e4 pawn takes d5
  ps = await props(t.frame)
  const grave = findProp(ps, -5.4, 0.02, 4.2)
  if (!grave || grave.color !== 0x241d16) fail('chess: captured pawn is not standing in white\'s graveyard')
  if (findProp(ps, sqX(3), 0.02, sqZ(4))?.color !== 0xf3ead6) fail('chess: white pawn did not take the square')
  const sanCap = await t.frame.evaluate(() =>
    window.__jig.net.client.getRooms().flatMap((r) => r.timeline ?? [])
      .some((ev) => ev.getType() === 'm.room.message' && ev.getContent().body === 'exd5'))
  if (!sanCap) fail('chess: capture was not announced as exd5')
  if (process.exitCode !== 1) console.log('chess: seat, drag legality, move ease, turn flip, chat and graveyard work')
  await t.page.close()
}

if (process.exitCode !== 1) console.log('GAMES TEST PASSED')
await browser.close()
