import { anyPass, equals, isNil, map, propSatisfies, uniqWith } from 'ramda'
// import { addAbortSignal } from 'stream'
import { pipeline } from 'stream/promises'

import {
  createEndOfStoredEventsNoticeMessage,
  createNoticeMessage,
  createOutgoingEventMessage,
} from '../utils/messages'
import { IAbortable, IMessageHandler } from '../@types/message-handlers'
import { isEventMatchingFilter, toNostrEvent } from '../utils/event'
import { streamEach, streamEnd, streamFilter, streamMap } from '../utils/stream'
import { SubscriptionFilter, SubscriptionId } from '../@types/subscription'
import { createLogger } from '../factories/logger-factory'
import { Event } from '../@types/event'
import { IEventRepository } from '../@types/repositories'
import { IWebSocketAdapter } from '../@types/adapters'
import { Settings } from '../@types/settings'
import { SubscribeMessage } from '../@types/messages'
import { WebSocketAdapterEvent } from '../constants/adapter'

const debug = createLogger('subscribe-message-handler')

export class SubscribeMessageHandler implements IMessageHandler, IAbortable {
  //private readonly abortController: AbortController

  public constructor(
    private readonly webSocket: IWebSocketAdapter,
    private readonly eventRepository: IEventRepository,
    private readonly settings: () => Settings
  ) {
    //this.abortController = new AbortController()
  }

  public abort(): void {
    //this.abortController.abort()
  }

  public async handleMessage(message: SubscribeMessage): Promise<void> {
    const subscriptionId = message[1]
    const filters = uniqWith(equals, message.slice(2)) as SubscriptionFilter[]

    const reason = this.canSubscribe(subscriptionId, filters)
    if (reason) {
      debug(
        'subscription %s with %o rejected: %s',
        subscriptionId,
        filters,
        reason
      )
      this.webSocket.emit(
        WebSocketAdapterEvent.Message,
        createNoticeMessage(`Subscription rejected: ${reason}`)
      )
      return
    }

    this.webSocket.emit(
      WebSocketAdapterEvent.Subscribe,
      subscriptionId,
      filters
    )

    await this.fetchAndSend(subscriptionId, filters)
  }

  private async fetchAndSend(
    subscriptionId: string,
    filters: SubscriptionFilter[]
  ): Promise<void> {
    debug(
      'fetching events for subscription %s with filters %o',
      subscriptionId,
      filters
    )
    const sendEvent = (event: Event) =>
      this.webSocket.emit(
        WebSocketAdapterEvent.Message,
        createOutgoingEventMessage(subscriptionId, event)
      )
    const sendEOSE = () =>
      this.webSocket.emit(
        WebSocketAdapterEvent.Message,
        createEndOfStoredEventsNoticeMessage(subscriptionId)
      )
    const isSubscribedToEvent =
      SubscribeMessageHandler.isClientSubscribedToEvent(filters)

    const findEvents = this.eventRepository.findByFilters(filters).stream()

    // const abortableFindEvents = addAbortSignal(this.abortController.signal, findEvents)

    try {
      await pipeline(
        findEvents,
        streamFilter(propSatisfies(isNil, 'deleted_at')),
        streamMap(toNostrEvent),
        streamFilter(isSubscribedToEvent),
        streamEach(sendEvent),
        streamEnd(sendEOSE)
      )
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        debug('subscription %s aborted: %o', subscriptionId, error)
        findEvents.destroy()
      } else {
        debug('error streaming events: %o', error)
      }
      throw error
    }
  }

  private static isClientSubscribedToEvent(
    filters: SubscriptionFilter[]
  ): (event: Event) => boolean {
    return anyPass(map(isEventMatchingFilter)(filters))
  }

  private canSubscribe(
    subscriptionId: SubscriptionId,
    filters: SubscriptionFilter[]
  ): string | undefined {
    const subscriptions = this.webSocket.getSubscriptions()
    const existingSubscription = subscriptions.get(subscriptionId)
    const subscriptionLimits = this.settings().limits?.client?.subscription

    if (existingSubscription?.length && equals(filters, existingSubscription)) {
      return `Duplicate subscription ${subscriptionId}: Ignorning`
    }

    const maxSubscriptions = subscriptionLimits?.maxSubscriptions ?? 0
    if (
      maxSubscriptions > 0 &&
      !existingSubscription?.length &&
      subscriptions.size + 1 > maxSubscriptions
    ) {
      return `Too many subscriptions: Number of subscriptions must be less than or equal to ${maxSubscriptions}`
    }

    const maxFilters = subscriptionLimits?.maxFilters ?? 0
    if (maxFilters > 0) {
      if (filters.length > maxFilters) {
        return `Too many filters: Number of filters per susbscription must be less then or equal to ${maxFilters}`
      }
    }

    if (
      typeof subscriptionLimits.maxSubscriptionIdLength === 'number' &&
      subscriptionId.length > subscriptionLimits.maxSubscriptionIdLength
    ) {
      return `Subscription ID too long: Subscription ID must be less or equal to ${subscriptionLimits.maxSubscriptionIdLength}`
    }
  }
}
