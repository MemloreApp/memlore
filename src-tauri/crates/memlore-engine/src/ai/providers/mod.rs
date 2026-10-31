//! Concrete `AIProvider` implementations.
//!
//! Phase 6 v2 R2 lands one impl, [`openai_compat::OpenAICompatibleProvider`],
//! which speaks the OpenAI chat-completions / embeddings / images wire
//! format. That single impl covers every preset on the Phase 6 v2 provider
//! matrix:
//!
//! - **🔒 Local** — Ollama, LM Studio, llama.cpp `llama-server`, vLLM,
//!   LocalAI, anything else exposing an OpenAI-compatible loopback endpoint.
//! - **🌍 Hosted** — OpenAI, Anthropic (via OAI-compat shim at `/v1`),
//!   Gemini (via `generativelanguage.googleapis.com/v1beta/openai`), xAI,
//!   OpenRouter, Together, Groq.
//! - **Custom** — user-supplied endpoint + key.
//!
//! Native non-OAI shapes (Anthropic `/v1/messages`, Gemini `generateContent`)
//! land as separate impls in later chunks if quality measurably differs.

#[cfg(feature = "fastembed")]
pub mod on_device_embed;
pub mod openai_compat;

#[cfg(any(test, feature = "test-support"))]
pub mod testing;
