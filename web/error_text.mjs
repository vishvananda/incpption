// JavaScriptCore's stack contains frames without the exception's message.
export function errorText(error) {
  const message = String(error), stack = error?.stack;
  return !stack || stack.includes(message) ? stack || message : message + '\n' + stack;
}
