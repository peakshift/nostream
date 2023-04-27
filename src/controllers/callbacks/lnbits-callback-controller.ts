import { Request, Response } from 'express'

import { Invoice, InvoiceStatus } from '../../@types/invoice'
import { createLogger } from '../../factories/logger-factory'
import { IController } from '../../@types/controllers'
import { IInvoiceRepository } from '../../@types/repositories'
import { IPaymentsService } from '../../@types/services'

const debug = createLogger('lnbits-callback-controller')

export class LNbitsCallbackController implements IController {
  public constructor(
    private readonly paymentsService: IPaymentsService,
    private readonly invoiceRepository: IInvoiceRepository
  ) { }

  // TODO: Validate
  public async handleRequest(
    request: Request,
    response: Response,
  ) {
    debug('request headers: %o', request.headers)
    debug('request body: %o', request.body)

    const body = request.body
    if (!body || typeof body !== 'object' || typeof body.payment_hash !== 'string' || body.payment_hash.length !== 64) {
      response
        .status(400)
        .setHeader('content-type', 'text/plain; charset=utf8')
        .send('Malformed body')
      return
    }

    const invoice = await this.paymentsService.getInvoiceFromPaymentsProcessor(body.payment_hash)
    const storedInvoice = await this.invoiceRepository.findById(body.payment_hash)

    if (!storedInvoice) {
      response
        .status(404)
        .setHeader('content-type', 'text/plain; charset=utf8')
        .send('No such invoice')
      return
    }

    try {
      await this.paymentsService.updateInvoice(invoice)
    } catch (error) {
      console.error(`Unable to persist invoice ${invoice.id}`, error)

      throw error
    }

    if (
      invoice.status !== InvoiceStatus.COMPLETED
      && !invoice.confirmedAt
    ) {
      response
        .status(200)
        .send()

      return
    }

    if (storedInvoice.status === InvoiceStatus.COMPLETED) {
      response
        .status(409)
        .setHeader('content-type', 'text/plain; charset=utf8')
        .send('Invoice is already marked paid')
      return
    }

    invoice.amountPaid = invoice.amountRequested

    try {
      await this.paymentsService.confirmInvoice(invoice as Invoice)
      await this.paymentsService.sendInvoiceUpdateNotification(invoice as Invoice)
    } catch (error) {
      console.error(`Unable to confirm invoice ${invoice.id}`, error)

      throw error
    }

    response
      .status(200)
      .setHeader('content-type', 'text/plain; charset=utf8')
      .send('OK')
  }
}
