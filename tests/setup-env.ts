// Points every test at the test database and keeps LLM keys out of tests (replay/scripted only).
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? "postgres://omni@localhost:54329/omniresolve_test";
process.env.GROQ_API_KEY = "";
process.env.GEMINI_API_KEY = "";
process.env.DEFAULT_MODE = "replay";
