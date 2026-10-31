// Errors that carry an HTTP status so the API can report them precisely.
export class AppError extends Error {
  status: number
  code: string
  details?: unknown
  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message)
    this.status = status
    this.code = code
    this.details = details
  }
}

export const notFound = (what: string) => new AppError(404, 'not_found', `${what} not found`)
export const invalid = (message: string, details?: unknown) => new AppError(400, 'invalid', message, details)
