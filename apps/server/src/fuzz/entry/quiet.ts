// The server logs every refusal (once per connection); under the fuzzer
// that is millions of lines. Findings come back as thrown errors instead.
console.warn = () => {};
console.error = () => {};
console.log = () => {};
