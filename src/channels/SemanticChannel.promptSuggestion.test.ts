import { describe, expect, it } from 'vitest'

import { SemanticChannel } from './SemanticChannel.js'
import type { SemanticEvent } from './types.js'

describe('SemanticChannel prompt observations', () => {
  it('emits a prompt suggestion on both the named and catch-all channels', () => {
    const channel = new SemanticChannel()
    const named: SemanticEvent[] = []
    const all: SemanticEvent[] = []
    channel.on('prompt_suggestion', event => named.push(event))
    channel.on('event', event => all.push(event))

    channel.publishPromptSuggestion({
      flowId: 'flow-1',
      turnId: 'msg_1',
      text: 'run the tests',
      source: 'proxy',
    })

    expect(named).toHaveLength(1)
    expect(all).toHaveLength(1)
    expect(named[0]).toMatchObject({
      type: 'prompt_suggestion',
      text: 'run the tests',
      flowId: 'flow-1',
      turnId: 'msg_1',
    })
    expect(named[0]?.ts).toEqual(expect.any(Number))
  })

  it('emits a provider session observation on both channel surfaces', () => {
    const channel = new SemanticChannel()
    const named: SemanticEvent[] = []
    const all: SemanticEvent[] = []
    channel.on('provider_session_observed', event => named.push(event))
    channel.on('event', event => all.push(event))

    channel.publishProviderSessionObserved({
      provider: 'claude',
      providerSessionId: 'claude-session-1',
      flowId: 'flow-1',
      source: 'proxy',
      confidence: 'high',
    })

    expect(named).toHaveLength(1)
    expect(all).toHaveLength(1)
    expect(named[0]).toMatchObject({
      type: 'provider_session_observed',
      provider: 'claude',
      providerSessionId: 'claude-session-1',
      flowId: 'flow-1',
      source: 'proxy',
      confidence: 'high',
    })
    expect(named[0]?.ts).toEqual(expect.any(Number))
  })
})
