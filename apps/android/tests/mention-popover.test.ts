import { describe, expect, it } from 'vitest'
import { detectMention, filterByQuery, fileMentionText, maskPersonalPath } from '../src/ui/mention-helpers'

describe('mention trigger detection', () => {
  it('detects / at the start of input', () => {
    expect(detectMention('/', 1)).toEqual({ type: 'command', query: '', start: 0 })
    expect(detectMention('/compact', 8)).toEqual({ type: 'command', query: 'compact', start: 0 })
  })

  it('detects / after whitespace', () => {
    expect(detectMention('hello /', 7)).toEqual({ type: 'command', query: '', start: 6 })
    expect(detectMention('hello /goal', 11)).toEqual({ type: 'command', query: 'goal', start: 6 })
  })

  it('detects @ at the start of input', () => {
    expect(detectMention('@', 1)).toEqual({ type: 'context', query: '', start: 0 })
    expect(detectMention('@README', 7)).toEqual({ type: 'context', query: 'README', start: 0 })
  })

  it('detects @ after whitespace', () => {
    expect(detectMention('see @', 5)).toEqual({ type: 'context', query: '', start: 4 })
    expect(detectMention('see @file', 9)).toEqual({ type: 'context', query: 'file', start: 4 })
  })

  it('ignores triggers inside words or emails', () => {
    expect(detectMention('user@example.com', 5)).toBeUndefined()
    expect(detectMention('user@example.com', 16)).toBeUndefined()
    expect(detectMention('path/to/file', 5)).toBeUndefined()
    expect(detectMention('https://example.com', 6)).toBeUndefined()
  })

  it('closes naturally when typing past a space', () => {
    expect(detectMention('/goal achieve', 13)).toBeUndefined()
    expect(detectMention('@file readme', 12)).toBeUndefined()
  })
})

interface TestItem {
  title: string
  desc: string
}

describe('mention fuzzy query filtering', () => {
  const items: TestItem[] = [
    { title: '文件 file', desc: '在消息中引用电脑上的文件' },
    { title: '目标 goal', desc: '设置或查看长期任务目标' },
    { title: '计划 plan', desc: '进入或退出计划模式' },
    { title: '反馈 feedback', desc: '发送关于当前会话的反馈' },
    { title: 'office-docx', desc: '创建、读取、编辑和检查 Word 文档' },
  ]
  const textOf = (item: TestItem) => [item.title, item.desc]

  it('returns all items when query is empty', () => {
    expect(filterByQuery(items, '', textOf)).toEqual(items)
    expect(filterByQuery(items, '   ', textOf)).toEqual(items)
  })

  it('matches title case-insensitively and ranks prefix first', () => {
    const results = filterByQuery(items, 'goal', textOf)
    expect(results[0]?.title).toBe('目标 goal')
  })

  it('matches description', () => {
    const results = filterByQuery(items, 'Word', textOf)
    expect(results[0]?.title).toBe('office-docx')
  })
})

describe('file mention formatting', () => {
  it('formats files with @file:`path` convention', () => {
    expect(fileMentionText('README.md')).toBe('@file:`README.md` ')
    expect(fileMentionText('src/components/button.tsx')).toBe('@file:`src/components/button.tsx` ')
  })

  it('formats directories with a trailing slash inside backticks', () => {
    expect(fileMentionText('src', true)).toBe('@file:`src/` ')
    expect(fileMentionText('src/', true)).toBe('@file:`src/` ')
  })
})

describe('privacy path masking', () => {
  it('masks Windows HuaweiMoveData personal user paths', () => {
    const path = 'D:\\HuaweiMoveData\\Users\\developer\\Documents\\deepseek-harness\\default-workspace'
    expect(maskPersonalPath(path)).toBe('~\\Documents\\deepseek-harness\\default-workspace')
  })

  it('masks standard Windows user paths', () => {
    const path = 'C:\\Users\\JohnDoe\\projects\\app'
    expect(maskPersonalPath(path)).toBe('~\\projects\\app')
  })

  it('masks Unix user home paths', () => {
    expect(maskPersonalPath('/Users/alice/projects/test')).toBe('~/projects/test')
    expect(maskPersonalPath('/home/bob/projects/test')).toBe('~/projects/test')
  })

  it('preserves clean workspace paths', () => {
    expect(maskPersonalPath('D:\\projects\\repo')).toBe('D:\\projects\\repo')
  })
})
