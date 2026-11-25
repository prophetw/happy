/** Fastify's request-body limit, including the JSON wrapper and encrypted base64. */
export const SESSION_MESSAGE_HTTP_BODY_LIMIT = 100 * 1024 * 1024;
export const SESSION_MESSAGE_POST_MAX_COUNT = 100;

// Use the Relay's existing 8 MiB transport budget for grouping messages.
// A single larger record still travels alone up to the HTTP request limit.
export const SESSION_MESSAGE_BATCH_BYTES = 8 * 1024 * 1024;
