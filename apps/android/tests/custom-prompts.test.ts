import { beforeEach, describe, expect, it, vi } from 'vitest'

const store = new Map<string, string>()

vi.mock('expo-secure-store', () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'whenUnlockedThisDeviceOnly',
  getItemAsync: vi.fn(async (key: string) => store.get(key) ?? null),
  setItemAsync: vi.fn(async (key: string, value: string) => { store.set(key, value) }),
  deleteItemAsync: vi.fn(async (key: string) => { store.delete(key) }),
  isAvailableAsync: vi.fn(async () => true),
}))
vi.mock('expo-application', () => ({ applicationId: 'io.github.liguobao.dshremote' }))
vi.mock('expo-device', () => ({ modelName: 'Pixel' }))
vi.mock('expo-crypto', () => ({ getRandomBytes: () => new Uint8Array(32), randomUUID: () => 'uuid' }))

import { BUILT_IN_PROMPTS, loadCustomPrompts, saveCustomPrompts, type CustomPrompt } from '../src/services/storage'

const KEY = 'dshremote.custom-prompts.v1'
const titles = (items: readonly CustomPrompt[]) => items.map(item => `${item.title}|${item.text}`)

/** Mirrors the write path in chat-screen: full list plus the deleted built-in ids. */
async function persist(next: CustomPrompt[]) {
  const removed = BUILT_IN_PROMPTS.filter(item => !next.some(prompt => prompt.id === item.id)).map(item => item.id)
  await saveCustomPrompts(next, removed)
}

const custom = (id: string, title: string, text: string): CustomPrompt => ({ id, title, text })

const builtIn = (id: string): CustomPrompt => {
  const found = BUILT_IN_PROMPTS.find(item => item.id === id)
  if (found === undefined) throw new Error(`unknown built-in prompt: ${id}`)
  return { ...found }
}

beforeEach(() => {
  store.clear()
})

describe('custom prompt persistence', () => {
  it('seeds the three built-in prompts on a fresh install', async () => {
    await expect(loadCustomPrompts()).resolves.toEqual([...BUILT_IN_PROMPTS])
  })

  it('keeps an edited built-in prompt across a reload', async () => {
    const edited = BUILT_IN_PROMPTS.map(item => item.id === 'builtin-commit' ? { ...item, title: '提交改动', text: '直接提交。' } : item)
    await persist(edited)

    const loaded = await loadCustomPrompts()
    expect(titles(loaded)).toEqual(titles(edited))
    expect(loaded.find(item => item.id === 'builtin-commit')).toEqual({ id: 'builtin-commit', title: '提交改动', text: '直接提交。' })
  })

  it('keeps a deleted built-in prompt deleted across a reload', async () => {
    const kept = BUILT_IN_PROMPTS.filter(item => item.id !== 'builtin-view-screenshot')
    await persist(kept)

    const loaded = await loadCustomPrompts()
    expect(loaded.map(item => item.id)).toEqual(kept.map(item => item.id))
  })

  it('round-trips an added custom prompt and its deletion', async () => {
    const added = [...BUILT_IN_PROMPTS, custom('prompt-1', '我的提示词', '跑一遍测试。')]
    await persist(added)
    expect((await loadCustomPrompts()).map(item => item.id)).toEqual([...BUILT_IN_PROMPTS.map(item => item.id), 'prompt-1'])

    await persist([...BUILT_IN_PROMPTS])
    expect(await loadCustomPrompts()).toEqual([...BUILT_IN_PROMPTS])
  })

  it('combines an edited, a deleted and an added prompt in one write', async () => {
    const next = [
      { ...builtIn('builtin-check-changes'), title: '检查改动（改）' },
      builtIn('builtin-commit'),
      custom('prompt-2', '新提示词', '正文。'),
    ]
    await persist(next)

    const loaded = await loadCustomPrompts()
    expect(loaded.map(item => item.id)).toEqual(['builtin-check-changes', 'builtin-commit', 'prompt-2'])
    expect(loaded.find(item => item.id === 'builtin-check-changes')?.title).toBe('检查改动（改）')
  })

  it('migrates legacy data that kept only custom items and had no removed list', async () => {
    store.set(KEY, JSON.stringify({ items: [custom('prompt-legacy', '旧提示词', '旧正文。')] }))
    await expect(loadCustomPrompts()).resolves.toEqual([...BUILT_IN_PROMPTS, custom('prompt-legacy', '旧提示词', '旧正文。')])
  })

  it('ignores malformed stored entries instead of throwing', async () => {
    store.set(KEY, JSON.stringify({
      items: [custom('prompt-ok', '好的', '正文。'), { id: '', title: 'x', text: 'y' }, { id: 'prompt-bad', title: '', text: 'y' }],
      removed: ['builtin-commit', 42, null],
    }))

    const loaded = await loadCustomPrompts()
    expect(loaded.map(item => item.id)).toEqual(['builtin-check-changes', 'builtin-view-screenshot', 'prompt-ok'])
  })

  it('drops everything when every prompt is deleted', async () => {
    await persist([])
    await expect(loadCustomPrompts()).resolves.toEqual([])
  })
})
