// Imported first by each fuzz target: the server modules the live handler
// pulls in open the database when they load, so the harness points them at
// one in memory (the replay test's setup has set its own already).
process.env.DB_PATH ??= ':memory:';
process.env.NODE_ENV ??= 'test';
process.env.PUBLIC_URL ??= 'http://localhost:3000';
process.env.COOKIE_SECURE ??= 'false';
