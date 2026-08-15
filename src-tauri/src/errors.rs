use serde::Serialize;

/// Structured error kind for Tauri commands.
///
/// Previously every command returned `Result<T, String>` — the frontend could
/// only display `String` without branching on retryable vs fatal. This enum
/// is serialized as `{ kind, message, retryable }` so the new `ApiError`
/// mapper in `src/utils/typed-errors.ts` can handle it uniformly, while
/// `String` receivers still work via `Display`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppError {
    pub kind: ErrorKind,
    pub message: String,
    pub retryable: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ErrorKind {
    Network,
    Timeout,
    NotFound,
    RateLimited,
    Forbidden,
    InvalidInput,
    Offline,
    Cancelled,
    Unknown,
}

impl AppError {
    pub fn new(kind: ErrorKind, message: impl Into<String>, retryable: bool) -> Self {
        Self {
            kind,
            message: message.into(),
            retryable,
        }
    }
    pub fn network(msg: impl Into<String>) -> Self {
        Self::new(ErrorKind::Network, msg, true)
    }
    pub fn timeout(msg: impl Into<String>) -> Self {
        Self::new(ErrorKind::Timeout, msg, true)
    }
    pub fn not_found(msg: impl Into<String>) -> Self {
        Self::new(ErrorKind::NotFound, msg, false)
    }
    pub fn invalid_input(msg: impl Into<String>) -> Self {
        Self::new(ErrorKind::InvalidInput, msg, false)
    }
    pub fn unknown(msg: impl Into<String>) -> Self {
        Self::new(ErrorKind::Unknown, msg, false)
    }
}

impl std::fmt::Display for AppError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.message)
    }
}
impl std::error::Error for AppError {}

// Allow `Result<T, String>` sites to keep working during migration by
// converting `AppError` to its display message where the command signature
// still expects `String`. New commands should return `Result<T, AppError>`.
impl From<AppError> for String {
    fn from(err: AppError) -> Self {
        err.message
    }
}
