// Stand-in for the Anthropic SDK, used only by the tests. It has the same error
// classes the function checks for; the tests supply their own fake `messages.create`.
class APIError extends Error {}
export default class Anthropic {
  static APIError = APIError;
  static AuthenticationError = class AuthenticationError extends APIError {};
  static PermissionDeniedError = class PermissionDeniedError extends APIError {};
  static RateLimitError = class RateLimitError extends APIError {};
  constructor(opts) {
    this.opts = opts;
  }
}
