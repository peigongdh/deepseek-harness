/** Keyless persisted mechanism evidence and request disclosure in the real Web UI. */
import { fileURLToPath } from 'node:url'
import { chromium, type Browser, type Page } from 'playwright'
import { createSystemMessage } from '@deepseek-ai/dsh-llm'
import { SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import {
  captureStableAria, compareOrRefreshGolden, launchWebScaffold, seedSession,
  watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { newEnglishPage, saveFailureShot } from './support.ts'

const MODE = webSnapshotMode()
const EXPECTED = fileURLToPath(new URL('./expected/enhanced-mechanisms/ui.expected.md', import.meta.url))
const REQUEST = 'Review the implementation.\n' + 'Check the user-visible behavior, compare the evidence, and report the limitations. '.repeat(28)

function seed(): string {
  const lines = [JSON.stringify({ type: 'session', version: SESSION_FORMAT_VERSION, id: '{{sessionId}}',
    createdAt: 1784974100000, cwd: '{{cwd}}/workspace', isSeeded: false, delegationDepth: 0 })]
  let seq = 0
  const at = (type: string, data: unknown, append = false) => {
    lines.push(JSON.stringify({ seq, time: 1784974100000 + seq++, type, data, ...(append ? { surfaceOp: 'append' } : {}) }))
  }
  at('turn/start', { turn: 1 })
  at('step/start', { turn: 1, step: 1 })
  at('system/message', { turn: 1, step: 1, message: createSystemMessage('', '@deepseek-ai/dsh-system-prompt') }, true)
  at('user/message', { id: 'request', role: 'user', content: [{ type: 'text', text: REQUEST }], source: { kind: 'user' } }, true)
  at('plan/mode', { active: true })
  at('todo/write', { todos: [{ content: 'Review', status: 'in_progress' }] })
  at('tool-workflow/run-start', { runId: 'review', name: 'Independent review' })
  at('tool-workflow/agent-start', { runId: 'review', seq: 0, childId: 'reader', label: 'Read behavior', phase: 'review' })
  at('tool-workflow/agent-start', { runId: 'review', seq: 1, childId: 'checker', label: 'Check evidence', phase: 'review' })
  at('tool-workflow/agent-end', { runId: 'review', seq: 1, outcome: 'completed' })
  at('tool-workflow/agent-end', { runId: 'review', seq: 0, outcome: 'completed' })
  at('tool-workflow/run-end', { runId: 'review', stopReason: 'completed' })
  at('todo/write', { todos: [{ content: 'Review', status: 'completed' }] })
  at('plan/mode', { active: false })
  at('assistant/message', { turn: 1, step: 1, stream: [], message: { id: 'reply', role: 'assistant',
    content: [{ type: 'text', text: 'Review complete.' }], source: { kind: 'model', provider: 'snapshot', model: 'snapshot-replier' } } }, true)
  at('step/end', { turn: 1, step: 1 })
  at('turn/end', { turn: 1, reason: { kind: 'completed' } })
  at('turn/start', { turn: 2 })
  at('step/start', { turn: 2, step: 1 })
  at('user/message', { id: 'second-request', role: 'user', content: [{ type: 'text', text: 'Reset the list.' }], source: { kind: 'user' } }, true)
  at('todo/write', { todos: [] })
  at('assistant/message', { turn: 2, step: 1, stream: [], message: { id: 'second-reply', role: 'assistant',
    content: [{ type: 'text', text: 'List reset.' }], source: { kind: 'model', provider: 'snapshot', model: 'snapshot-replier' } } }, true)
  at('step/end', { turn: 2, step: 1 })
  at('turn/end', { turn: 2, reason: { kind: 'completed' } })
  return `${lines.join('\n')}\n`
}

describe('web e2e: enhanced mechanism relationships', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>
  beforeAll(async () => {
    if (MODE === 'record') throw new Error('enhanced mechanisms use a keyless assembled fixture')
    scaffold = await launchWebScaffold({})
    await seedSession(scaffold, seed(), 'enhanced-mechanisms')
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    await page.setViewportSize({ width: 2200, height: 1200 })
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.locator('[role="treeitem"]').first().click()
    await page.locator('[role="treeitem"]').nth(1).click()
    await page.getByText('List reset.', { exact: true }).waitFor()
    await page.getByRole('tab', { name: 'Enhanced trajectory', exact: true }).click()
    await page.getByRole('navigation', { name: 'User requests' }).getByRole('button', { name: 'Request 1', exact: false }).click()
  })
  afterAll(async () => {
    try { await browser?.close() } finally { await scaffold?.close() }
  })

  it('collapses long requests and shows recorded scheduling nodes with a larger tool area', async () => {
    onTestFailed(() => saveFailureShot(page, 'enhanced-mechanisms'))
    const enhanced = page.locator('[data-enhanced-trajectory]')
    const preview = enhanced.locator('[data-request-preview]')
    const initial = await preview.boundingBox()
    expect(initial!.height).toBeLessThan(50)
    await enhanced.getByRole('button', { name: 'Expand full request', exact: true }).click()
    expect((await preview.boundingBox())!.height).toBeGreaterThan(initial!.height * 2)
    await enhanced.getByRole('button', { name: 'Collapse request', exact: true }).click()
    expect((await preview.boundingBox())!.height).toBe(initial!.height)
    const lanes = await enhanced.locator('[data-lane]').evaluateAll(elements => elements.slice(0, 3).map(element => element.getBoundingClientRect().width))
    expect(lanes[1]).toBeCloseTo(lanes[0]!, 0)
    expect(lanes[2]! / lanes[0]!).toBeCloseTo(3, 1)
    const workflow = enhanced.locator('[data-scheduling-block="workflow"]')
    expect(await workflow.locator('[data-scheduling-member]').count()).toBe(2)
    expect(await workflow.getByText('Observed execution overlap', { exact: true }).count()).toBe(1)
    expect(await workflow.locator('[data-scheduling-raw]').getAttribute('open')).toBeNull()
    const tracks = await workflow.locator('[data-complete="true"] > span').evaluateAll(elements => elements.map((element) => {
      const rect = element.getBoundingClientRect()
      return { left: rect.left, right: rect.right }
    }))
    expect(tracks[1]!.left).toBeGreaterThan(tracks[0]!.left)
    expect(tracks[1]!.right).toBeLessThan(tracks[0]!.right)
    expect(await enhanced.locator('[data-mechanism-edges]').count()).toBe(0)
    await compareOrRefreshGolden(EXPECTED, await captureStableAria(page, '[data-enhanced-trajectory]', scaffold.workspaceCwd), MODE)
    await workflow.locator('[data-enhanced-record="fact:7"]:visible').click()
    expect(await workflow.locator('[data-enhanced-record="fact:7"]:visible').getAttribute('aria-pressed')).toBe('true')
    await enhanced.getByRole('complementary', { name: 'Event details' }).waitFor()
    await enhanced.getByRole('button', { name: 'Close details', exact: true }).click()
    await workflow.getByText('Inspect 6 raw events', { exact: true }).click()
    expect(await workflow.locator('[data-scheduling-raw]').getAttribute('open')).not.toBeNull()
    const rawEnd = workflow.locator('[data-scheduling-raw] [data-enhanced-record="fact:9"]')
    await rawEnd.focus()
    await rawEnd.press('Enter')
    await enhanced.getByRole('complementary', { name: 'Event details' }).waitFor()
    await enhanced.getByRole('button', { name: 'Close details', exact: true }).click()
    await workflow.getByText('Inspect 6 raw events', { exact: true }).click()
    expect(await page.locator('[class*="_frame"]').first().evaluate(element => element.scrollLeft)).toBe(0)
    await page.emulateMedia({ colorScheme: 'dark' })
    await workflow.evaluate((element) => {
      const canvas = element.closest('main')!
      canvas.scrollTop += element.getBoundingClientRect().top - canvas.getBoundingClientRect().top - 24
    })
    await page.screenshot({ path: '.artifacts/enhanced-mechanisms-dark.png' })
    await page.emulateMedia({ colorScheme: 'light' })
  })

  it('resets request disclosure and follows a state reference across request groups', async () => {
    const enhanced = page.locator('[data-enhanced-trajectory]')
    const requests = enhanced.getByRole('navigation', { name: 'User requests' })
    await enhanced.getByRole('button', { name: 'Expand full request', exact: true }).click()
    await requests.getByRole('button', { name: 'Request 2', exact: false }).click()
    expect(await enhanced.getByRole('button', { name: 'Expand full request', exact: true }).count()).toBe(0)
    await enhanced.getByRole('button', { name: 'Previous state · #12', exact: false }).click()
    expect(await requests.getByRole('button', { name: 'Request 1', exact: false }).getAttribute('aria-current')).toBe('true')
    expect(await enhanced.locator('[data-request-preview]').getAttribute('data-expanded')).toBe('false')
    expect(await enhanced.locator('[data-enhanced-record="fact:12"]').getAttribute('aria-pressed')).toBe('true')
    await enhanced.getByRole('button', { name: 'Close details', exact: true }).click()
  })

  it('keeps mechanism cards within the canvas after responsive stacking', async () => {
    await page.setViewportSize({ width: 760, height: 900 })
    const enhanced = page.locator('[data-enhanced-trajectory]')
    const bounds = await enhanced.evaluate((element) => {
      const canvas = element.querySelector('main')!.getBoundingClientRect()
      return [...element.querySelectorAll('[data-enhanced-record]')].filter(card => card.getClientRects().length > 0).map((card) => {
        const rect = card.getBoundingClientRect()
        return rect.left >= canvas.left && rect.right <= canvas.right
      })
    })
    expect(bounds.every(Boolean)).toBe(true)
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  })
})
