import { EventKindsRange, EventRateLimit, ISettings } from '../@types/settings'
import {
  getEventProofOfWork,
  getPubkeyProofOfWork,
  isEventIdValid,
  isEventSignatureValid,
} from '../utils/event'
import { IEventStrategy, IMessageHandler } from '../@types/message-handlers'
import axios from 'axios'
import { createCommandResult } from '../utils/messages'
import { createLogger } from '../factories/logger-factory'
import { Event } from '../@types/event'
import { EventKinds } from '../constants/base'
import { Factory } from '../@types/base'
import { IncomingEventMessage } from '../@types/messages'
import { IRateLimiter } from '../@types/utils'
import { IWebSocketAdapter } from '../@types/adapters'
import { WebSocketAdapterEvent } from '../constants/adapter'

const debug = createLogger('event-message-handler')

export class EventMessageHandler implements IMessageHandler {
  public constructor(
    protected readonly webSocket: IWebSocketAdapter,
    protected readonly strategyFactory: Factory<
      IEventStrategy<Event, Promise<void>>,
      [Event, IWebSocketAdapter]
    >,
    private readonly settings: () => ISettings,
    private readonly slidingWindowRateLimiter: Factory<IRateLimiter>
  ) {}

  public async handleMessage(message: IncomingEventMessage): Promise<void> {
    const [, event] = message

    let reason = await this.isEventValid(event)
    if (reason) {
      debug('event %s rejected: %s', event.id, reason)
      this.webSocket.emit(
        WebSocketAdapterEvent.Message,
        createCommandResult(event.id, false, reason)
      )
      return
    }

    if (await this.isRateLimited(event)) {
      debug('event %s rejected: rate-limited')
      this.webSocket.emit(
        WebSocketAdapterEvent.Message,
        createCommandResult(event.id, false, 'rate-limited: slow down')
      )
      return
    }

    reason = this.canAcceptEvent(event)
    if (reason) {
      debug('event %s rejected: %s', event.id, reason)
      this.webSocket.emit(
        WebSocketAdapterEvent.Message,
        createCommandResult(event.id, false, reason)
      )
      return
    }

    const strategy = this.strategyFactory([event, this.webSocket])

    if (typeof strategy?.execute !== 'function') {
      this.webSocket.emit(
        WebSocketAdapterEvent.Message,
        createCommandResult(event.id, false, 'error: event not supported')
      )
      return
    }

    try {
      await strategy.execute(event)
    } catch (error) {
      console.error('error handling message', message, error)
      this.webSocket.emit(
        WebSocketAdapterEvent.Message,
        createCommandResult(event.id, false, 'error: unable to process event')
      )
    }

    // At the end, we can do any side effect we want, like: sending notifications:
    if (this.isCommentEvent(event)) await sendNewCommentNotification(event)
  }

  protected canAcceptEvent(event: Event): string | undefined {
    const now = Math.floor(Date.now() / 1000)
    const limits = this.settings().limits.event

    if (!this.isBoltFunEvent(event)) {
      return 'rejected: this relay is private & only accepts bolt.fun events.'
    }

    if (
      limits.content.maxLength > 0 &&
      event.content.length > limits.content.maxLength
    ) {
      return `rejected: content is longer than ${limits.content.maxLength} bytes`
    }

    if (
      limits.createdAt.maxPositiveDelta > 0 &&
      event.created_at > now + limits.createdAt.maxPositiveDelta
    ) {
      return `rejected: created_at is more than ${limits.createdAt.maxPositiveDelta} seconds in the future`
    }

    if (
      limits.createdAt.maxNegativeDelta > 0 &&
      event.created_at < now - limits.createdAt.maxNegativeDelta
    ) {
      return `rejected: created_at is more than ${limits.createdAt.maxNegativeDelta} seconds in the past`
    }

    if (limits.eventId.minLeadingZeroBits > 0) {
      const pow = getEventProofOfWork(event.id)
      if (pow < limits.eventId.minLeadingZeroBits) {
        return `pow: difficulty ${pow}<${limits.eventId.minLeadingZeroBits}`
      }
    }

    if (limits.pubkey.minLeadingZeroBits > 0) {
      const pow = getPubkeyProofOfWork(event.pubkey)
      if (pow < limits.pubkey.minLeadingZeroBits) {
        return `pow: pubkey difficulty ${pow}<${limits.pubkey.minLeadingZeroBits}`
      }
    }

    if (
      limits.pubkey.whitelist.length > 0 &&
      !limits.pubkey.whitelist.some((prefix) => event.pubkey.startsWith(prefix))
    ) {
      return 'blocked: pubkey not allowed'
    }

    if (
      limits.pubkey.blacklist.length > 0 &&
      limits.pubkey.blacklist.some((prefix) => event.pubkey.startsWith(prefix))
    ) {
      return 'blocked: pubkey not allowed'
    }

    const isEventKindMatch = (item: EventKinds | EventKindsRange) =>
      typeof item === 'number'
        ? item === event.kind
        : event.kind >= item[0] && event.kind <= item[1]

    if (
      limits.kind.whitelist.length > 0 &&
      !limits.kind.whitelist.some(isEventKindMatch)
    ) {
      return `blocked: event kind ${event.kind} not allowed`
    }

    if (
      limits.kind.blacklist.length > 0 &&
      limits.kind.blacklist.some(isEventKindMatch)
    ) {
      return `blocked: event kind ${event.kind} not allowed`
    }
  }

  protected isBoltFunEvent(event: Event): boolean {
    return this.isCommentEvent(event) || false // as we add more time of accepted events
  }

  protected isCommentEvent(event: Event) {
    const rTag = event.tags.find((tag) => tag[0] === 'r')?.[1]
    const eTag = event.tags.find(
      (tag) => tag[0] === 'e' && tag[3] === 'root'
    )?.[1]

    const clientTagBoltFun = event.tags.some(
      (tag) => tag[0] === 'client' && tag[1] == 'makers.bolt.fun'
    )

    const validUrlInRTag = BF_STORY_URL_REGEX.test(rTag ?? '')
    const validRootEventRef = !!eTag
    // Maybe later we should find a more reliable way to see if the event id actually refs a story root event or not.

    if (
      event.kind === 1 &&
      clientTagBoltFun &&
      (validUrlInRTag || validRootEventRef)
    )
      return true

    return false
  }

  protected async isEventValid(event: Event): Promise<string | undefined> {
    if (!(await isEventIdValid(event))) {
      return 'invalid: event id does not match'
    }
    if (!(await isEventSignatureValid(event))) {
      return 'invalid: event signature verification failed'
    }
  }

  protected async isRateLimited(event: Event): Promise<boolean> {
    const { whitelists, rateLimits } = this.settings().limits?.event ?? {}
    if (!rateLimits || !rateLimits.length) {
      return false
    }

    if (
      Array.isArray(whitelists?.pubkeys) &&
      whitelists.pubkeys.includes(event.pubkey)
    ) {
      return false
    }

    if (
      Array.isArray(whitelists?.ipAddresses) &&
      whitelists.ipAddresses.includes(this.webSocket.getClientAddress())
    ) {
      return false
    }

    const rateLimiter = this.slidingWindowRateLimiter()

    const toString = (input: any | any[]): string => {
      return Array.isArray(input)
        ? `[${input.map(toString)}]`
        : input.toString()
    }

    const hit = ({ period, rate, kinds = undefined }: EventRateLimit) => {
      const key = Array.isArray(kinds)
        ? `${event.pubkey}:events:${period}:${toString(kinds)}`
        : `${event.pubkey}:events:${period}`

      return rateLimiter.hit(key, 1, { period, rate })
    }

    const hits = await Promise.all(rateLimits.map(hit))

    debug('rate limit check %s: %o', event.pubkey, hits)

    return hits.some((active) => active)
  }
}

const BF_STORY_URL_REGEX =
  /(?:http|https):\/\/(makers.bolt.fun|deploy-preview-[\d]+--makers-bolt-fun.netlify.app|makers-bolt-fun-preview.netlify.app|localhost:3000)\/story\/([\w.,@?^=%&:/~+#-]*[\w@?^=%&/~+#-])/m

function sendNewCommentNotification(event: Event) {
  // const storyUrl = BF_STORY_URL_REGEX.exec(event.content)?.[0]
  // console.log(storyUrl)

  // if (!storyUrl) {
  //   throw new Error("Event doesn't contain story URL in its content")
  // }

  const canonical_url = BF_STORY_URL_REGEX.exec(
    event.tags.find((tag) => tag[0] === 'r')?.[1] ?? ''
  )?.[0]

  if (!canonical_url) {
    throw new Error("Event tags doesn't contain canonical URL")
  }

  const story_id = extractStoryIdFromUrl(canonical_url)

  const args = {
    comment: {
      event_id: event.id,
      canonical_url,
      url: canonical_url,
      content: event.content,
      pubkey: event.pubkey,
      story_id,
    },
  }

  return axios.post(
    `${process.env.BF_QUEUE_SERVICE_URL}/add-job/new-comment-notification`,
    args,
    {
      headers: {
        Authorization: `Basic ${Buffer.from(
          `${process.env.BF_QUEUE_SERVICE_USERNAME}:${process.env.BF_QUEUE_SERVICE_PASS}`
        ).toString('base64')}`,
      },
    }
  )
}

function extractStoryIdFromUrl(url: string) {
  const matches = BF_STORY_URL_REGEX.exec(url)
  if (!matches) throw new Error('Invalid Url')

  const slugSegment = matches[2]

  const EXTRACT_STORY_ID_FROM_SLUG_REGEX = /(?:(?:[\w-]+)?(?:--))?([\d]+)/m

  return EXTRACT_STORY_ID_FROM_SLUG_REGEX.exec(slugSegment)?.[0]
}
