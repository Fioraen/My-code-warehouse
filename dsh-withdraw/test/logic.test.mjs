import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 测试用的日志写到临时目录，别把真实使用的 debug.log 搅成一团。
process.env.DSH_WITHDRAW_LOG = join(mkdtempSync(join(tmpdir(), 'dsh-withdraw-')), 'debug.log')

const plugin = await import('../index.js')

/** 装配一个假 ctx，抓取注册的 command 定义。 */
function makeCtx() {
  const commands = new Map()
  const flushed = []
  const ctx = {
    effect(fn) {
      return fn()
    },
    commands: {
      register(definition) {
        commands.set(definition.name, definition)
        return () => commands.delete(definition.name)
      },
    },
    sessions: {
      async flush(session) {
        flushed.push(session)
        return true
      },
    },
    logger: { warn() {} },
  }
  return { ctx, commands, flushed }
}

/**
 * 假会话，事件时间线与真实顺序一致（用户消息先于 turn/start）：
 *   0 系统 / 1 用户u1 / 2 turn-start(1) / 3 助手a1 / 4 turn-end(1)
 *   5 用户u2 / 6 turn-start(2) / 7 助手a2 / 8 turn-end(2)
 * surface 节点 = [0, 1, 3, 5, 7]
 *
 * append 会像真实 Session 一样按 surfaceOp 更新节点表，并返回新事件，
 * 这样二次合并（replace 一个区间）的行为也能被断言。
 */
function makeSession(options = {}) {
  const interrupted = options.interruptLast === true
  const events = new Map([
    [0, { type: 'system/message', data: { id: 's', role: 'system', content: [], source: { kind: 'system-prompt' } } }],
    [1, { type: 'user/message', data: { id: 'u1', role: 'user', content: [{ type: 'text', text: '第一问' }], source: { kind: 'user' } } }],
    [2, { type: 'turn/start', data: { turn: 1 } }],
    [3, { type: 'assistant/message', data: { id: 'a1', role: 'assistant', content: [], source: { kind: 'model', provider: 'p', model: 'm' } } }],
    [4, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } }],
    [5, { type: 'user/message', data: { id: 'u2', role: 'user', content: [{ type: 'text', text: '第二问' }], source: { kind: 'user' } } }],
    [6, { type: 'turn/start', data: { turn: 2 } }],
    [
      7,
      {
        type: 'assistant/message',
        data: {
          id: 'a2',
          role: 'assistant',
          content: [{ type: 'text', text: '写到一半' }],
          source: { kind: 'model', provider: 'p', model: 'm' },
          ...(interrupted ? { interrupted: true } : {}),
        },
      },
    ],
    [8, { type: 'turn/end', data: { turn: 2, reason: interrupted ? { kind: 'aborted' } : { kind: 'completed' } } }],
  ])

  const appends = []
  const nodes = [0, 1, 3, 5, 7]
  let nextSeq = 9
  /** 模拟「替换之后宿主又补写了一个节点」：只有第一次替换后发生，用来验证折回重试。 */
  let pendingGrowth = options.growAfterReplace === true

  function applySurface(seq, opts) {
    const op = opts?.surfaceOp
    if (op === undefined || op === 'append') {
      nodes.push(seq)
      return
    }
    const startIdx = nodes.indexOf(op.startSeq)
    const endIdx = nodes.indexOf(op.endSeq)
    if (startIdx < 0 || endIdx < startIdx) throw new Error('surface replace: bad range')
    nodes.splice(startIdx, endIdx - startIdx + 1, seq)
  }

  return {
    appends,
    nodes,
    surface: { nodes },
    eventAt(seq) {
      const event = events.get(seq)
      return event === undefined ? undefined : { type: event.type, seq, data: event.data }
    },
    ownEvents() {
      return [...events.entries()]
        .sort((left, right) => left[0] - right[0])
        .map(([seq, event]) => ({ type: event.type, seq, data: event.data }))
    },
    append(type, payload, opts) {
      const seq = nextSeq
      nextSeq += 1
      const event = { type, seq, data: payload }
      events.set(seq, event)
      appends.push({ type, payload, opts, seq })
      applySurface(seq, opts)
      if (pendingGrowth) {
        pendingGrowth = false
        const late = nextSeq
        nextSeq += 1
        events.set(late, {
          type: 'assistant/message',
          data: { id: 'late', role: 'assistant', content: [{ type: 'text', text: '宿主收尾' }], source: { kind: 'model', provider: 'p', model: 'm' } },
        })
        nodes.push(late)
      }
      return event
    },
  }
}

/** 假 agent：followup 时像宿主那样为这条 inbox 消息补写一行 user/message。 */
function makeAgent(session, status = 'idle') {
  const calls = { cancel: 0, followup: [], idle: 0 }
  return {
    calls,
    status,
    session,
    cancel() {
      calls.cancel += 1
      this.status = 'idle'
    },
    async whenIdle() {
      calls.idle += 1
    },
    followup(message) {
      calls.followup.push(message)
      session.append('user/message', message, { surfaceOp: 'append' })
    },
  }
}

const { ctx, commands, flushed } = makeCtx()
plugin.apply(ctx)

assert.equal(plugin.name, 'dsh-withdraw')
assert.deepEqual(plugin.inject, ['commands', 'sessions', 'agents'])
assert.deepEqual([...commands.keys()].sort(), ['revise', 'withdraw', 'withdraw-pause'])

let currentAgent = null
const invoke = (name, rawInput) =>
  commands.get(name).handler({
    agent: currentAgent,
    rawInput,
    attachments: [],
    commandId: 'c',
    signal: new AbortController().signal,
  })

// 1. 无参数撤回：作用于最后一条用户消息（seq 5），清除到最后一个节点。
{
  const session = makeSession()
  const agent = makeAgent(session)
  currentAgent = agent
  const result = await invoke('withdraw', '')
  assert.equal(result.kind, 'success', result.text)
  assert.equal(session.appends.length, 1)
  const [call] = session.appends
  assert.equal(call.type, 'user/message')
  assert.deepEqual(call.opts.surfaceOp, { op: 'replace', startSeq: 5, endSeq: 7 })
  assert.deepEqual(call.opts.sourceEventSeqs, [5, 7])
  assert.equal(call.payload.role, 'user')
  assert.equal(call.payload.source.kind, 'user')
  assert.match(call.payload.content[0].text, /已撤回/u)
  assert.notEqual(call.payload.id, 'u2')
  assert.equal(agent.calls.followup.length, 0, '撤回不应继续生成')
  assert.equal(agent.calls.cancel, 0, '空闲时不该 cancel')
  assert.equal(flushed.length, 1)
}

// 2. 按 turn 号撤回：turn 1 的用户消息在 turn/start 之前（seq 1），清除 1..7。
{
  const session = makeSession()
  const agent = makeAgent(session)
  currentAgent = agent
  await invoke('withdraw', '{"turn":1}')
  assert.deepEqual(session.appends[0].opts.surfaceOp, { op: 'replace', startSeq: 1, endSeq: 7 })
  assert.deepEqual(session.appends[0].opts.sourceEventSeqs, [1, 3, 5, 7])
}

// 3. 思考中撤回：先 cancel 再等空闲，然后才改写。
{
  const session = makeSession()
  const agent = makeAgent(session, 'running')
  currentAgent = agent
  await invoke('withdraw', '{"turn":2}')
  assert.equal(agent.calls.cancel, 1)
  assert.equal(agent.calls.idle, 1)
  assert.equal(session.appends.length, 1)
  assert.deepEqual(session.appends[0].opts.surfaceOp, { op: 'replace', startSeq: 5, endSeq: 7 })
}

// 4. 修改：先用「（已修改）」占位截断（正文交给 followup，模型只会看到一次），
//    宿主补写的那一行随后被合并成一条带新正文的消息。
{
  const session = makeSession()
  const agent = makeAgent(session)
  currentAgent = agent
  const result = await invoke('revise', '{"turn":2,"text":"改过的第二问"}')
  assert.equal(result.kind, 'success', result.text)

  const [replacement, wake, merge] = session.appends
  assert.equal(replacement.payload.content[0].text, '（已修改）', '替换节点先是占位')
  assert.deepEqual(replacement.opts.surfaceOp, { op: 'replace', startSeq: 5, endSeq: 7 })

  assert.equal(agent.calls.followup.length, 1)
  const queued = agent.calls.followup[0]
  assert.equal(queued.content[0].text, '改过的第二问')
  assert.equal(queued.role, 'user')
  assert.equal(queued.source.kind, 'user')

  assert.equal(wake.payload.id, queued.id, '宿主补写的是那条 inbox 消息')
  assert.deepEqual(merge.opts.surfaceOp, {
    op: 'replace',
    startSeq: replacement.seq,
    endSeq: wake.seq,
  })
  assert.deepEqual(merge.opts.sourceEventSeqs, [replacement.seq, wake.seq])
  assert.equal(merge.payload.content[0].text, '改过的第二问')

  assert.deepEqual(session.nodes, [0, 1, 3, merge.seq], '目标之前的内容保留，之后只剩一条改过的消息')
  assert.equal(agent.calls.idle, 0)
}

// 5. 修改缺内容：报错且不改写。
{
  const session = makeSession()
  const agent = makeAgent(session)
  currentAgent = agent
  const result = await invoke('revise', '{"turn":2}')
  assert.equal(result.kind, 'error')
  assert.equal(session.appends.length, 0)
}

// 6. 只有系统提示的会话：拒绝，不碰第 0 个节点。
{
  const session = makeSession()
  session.nodes.length = 0
  session.nodes.push(0)
  const agent = makeAgent(session)
  currentAgent = agent
  const result = await invoke('withdraw', '')
  assert.equal(result.kind, 'error')
  assert.equal(session.appends.length, 0)
}

// 7. 裸 seq 指向助手消息：回退到它前面那条用户消息。
{
  const session = makeSession()
  const agent = makeAgent(session)
  currentAgent = agent
  await invoke('withdraw', '3')
  assert.deepEqual(session.appends[0].opts.surfaceOp, { op: 'replace', startSeq: 1, endSeq: 7 })
}

// 8. turn 号不存在时退化为「最后一条用户消息」。
{
  const session = makeSession()
  const agent = makeAgent(session)
  currentAgent = agent
  await invoke('withdraw', '{"turn":99}')
  assert.deepEqual(session.appends[0].opts.surfaceOp, { op: 'replace', startSeq: 5, endSeq: 7 })
}

// 8b. 只暂停：正在思考时立刻 cancel，不等空闲（等空闲会让右键半天没反应），也不改写任何记录、不继续生成。
{
  const session = makeSession()
  const agent = makeAgent(session)
  agent.status = 'running'
  currentAgent = agent
  const before = flushed.length
  const result = await invoke('withdraw-pause', '')
  assert.equal(result.kind, 'success')
  assert.equal(result.text, undefined, '成功时不带文字，聊天里不多出一行')
  assert.equal(agent.calls.cancel, 1)
  assert.equal(agent.calls.idle, 0, '暂停只发 cancel，不等空闲')
  assert.equal(session.appends.length, 0)
  assert.equal(agent.calls.followup.length, 0)
  assert.equal(flushed.length, before + 1)
}


// 11. 替换之后宿主又补写了一个节点：折回去再折一次，末尾仍然只剩再换出来的那一条。
{
  const session = makeSession({ growAfterReplace: true })
  const agent = makeAgent(session)
  currentAgent = agent
  const result = await invoke('withdraw', '{"turn":2}')
  assert.equal(result.kind, 'success')
  assert.equal(session.appends.length, 2, '第一次替换后发现有新节点，再折一次')
  assert.deepEqual(session.nodes, [0, 1, 3, session.appends[1].seq])
}

console.log('all assertions passed')