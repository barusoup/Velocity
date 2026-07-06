use once_cell::sync::Lazy;
use std::sync::Mutex as StdMutex;
use tauri::{AppHandle, Manager, PhysicalPosition, PhysicalSize, WebviewWindow};

static SAVED_WINDOW_BOUNDS: Lazy<
    StdMutex<Option<(PhysicalSize<u32>, PhysicalPosition<i32>)>>,
> = Lazy::new(|| StdMutex::new(None));

static APP_FULLSCREEN: Lazy<StdMutex<bool>> = Lazy::new(|| StdMutex::new(false));

static APP_HANDLE: Lazy<StdMutex<Option<AppHandle>>> = Lazy::new(|| StdMutex::new(None));

const MAIN_WINDOW_LABEL: &str = "main";

#[cfg(windows)]
const FULLSCREEN_DRAG_SUBCLASS_ID: usize = 0x8F11;

pub fn init(app: AppHandle) {
    if let Ok(mut handle) = APP_HANDLE.lock() {
        *handle = Some(app);
    }
}

fn main_window() -> Option<WebviewWindow> {
    let handle = APP_HANDLE.lock().ok()?.clone()?;
    handle.get_webview_window(MAIN_WINDOW_LABEL)
}

#[tauri::command]
pub fn remember_window_bounds(window: WebviewWindow) -> Result<(), String> {
    let size = window.outer_size().map_err(|e| e.to_string())?;
    let position = window.outer_position().map_err(|e| e.to_string())?;
    #[cfg(windows)]
    {
        if window_fills_monitor(&window, size, position)? {
            // Pseudo-fullscreen dimensions — keep the pre-fullscreen bounds.
            if SAVED_WINDOW_BOUNDS
                .lock()
                .ok()
                .and_then(|saved| saved.clone())
                .is_some()
            {
                return Ok(());
            }
        }
    }
    if let Ok(mut saved) = SAVED_WINDOW_BOUNDS.lock() {
        *saved = Some((size, position));
    }
    Ok(())
}

#[tauri::command]
pub fn is_app_fullscreen() -> Result<bool, String> {
    APP_FULLSCREEN
        .lock()
        .map(|state| *state)
        .map_err(|e| e.to_string())
}

fn restore_saved_bounds(window: &WebviewWindow) -> Result<(), String> {
    let saved = SAVED_WINDOW_BOUNDS
        .lock()
        .map_err(|e| e.to_string())?
        .clone();
    if let Some((size, position)) = saved {
        window.set_size(size).map_err(|e| e.to_string())?;
        window.set_position(position).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Install a Win32 subclass so pseudo-fullscreen exit runs synchronously on
/// `WM_NCLBUTTONDOWN` (same path as `data-tauri-drag-region` / start_dragging).
#[cfg(windows)]
pub fn install_drag_hook(window: &WebviewWindow) -> Result<(), String> {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::Shell::SetWindowSubclass;

    let hwnd: HWND = window.hwnd().map_err(|e| e.to_string())?;
    unsafe {
        if !SetWindowSubclass(
            hwnd,
            Some(fullscreen_drag_subclass),
            FULLSCREEN_DRAG_SUBCLASS_ID,
            0,
        )
        .as_bool()
        {
            return Err("SetWindowSubclass failed.".to_string());
        }
    }
    Ok(())
}

#[cfg(not(windows))]
pub fn install_drag_hook(_window: &WebviewWindow) -> Result<(), String> {
    Ok(())
}

/// F11 fullscreen. On Windows this fills the monitor without OS exclusive
/// fullscreen so titlebar drags behave like other apps. Shadows are toggled
/// through Tauri's API so Tao's `WM_NCCALCSIZE` inset is removed for the
/// duration, then restored losslessly on exit.
#[tauri::command]
pub fn toggle_app_fullscreen(window: WebviewWindow) -> Result<bool, String> {
    #[cfg(windows)]
    {
        let fills_monitor = window_fills_current_monitor(&window)?;
        let mut app_fs = APP_FULLSCREEN.lock().map_err(|e| e.to_string())?;
        if *app_fs || fills_monitor {
            exit_pseudo_fullscreen(&window)?;
            *app_fs = false;
            return Ok(false);
        }
        remember_window_bounds(window.clone())?;
        apply_pseudo_fullscreen(&window)?;
        *app_fs = true;
        return Ok(true);
    }

    #[cfg(not(windows))]
    {
        let fs = window.is_fullscreen().map_err(|e| e.to_string())?;
        if !fs {
            remember_window_bounds(window.clone())?;
        }
        window.set_fullscreen(!fs).map_err(|e| e.to_string())?;
        Ok(!fs)
    }
}

#[cfg(windows)]
fn apply_pseudo_fullscreen(window: &WebviewWindow) -> Result<(), String> {
    // Must go through Tauri so Tao clears MARKER_UNDECORATED_SHADOW and
    // refreshes the drag-resize HWND region — raw WM_USER messages alone
    // leave the ~7px NCCALCSIZE inset that shows as edge gaps.
    window.set_shadow(false).map_err(|e| e.to_string())?;

    let monitor = window
        .current_monitor()
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "No current monitor.".to_string())?;
    let pos = monitor.position();
    let size = monitor.size();

    window
        .set_position(PhysicalPosition::new(pos.x, pos.y))
        .map_err(|e| e.to_string())?;
    window
        .set_size(PhysicalSize::new(size.width, size.height))
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(windows)]
fn exit_pseudo_fullscreen(window: &WebviewWindow) -> Result<(), String> {
    // Restore shadow before applying saved outer bounds so Tauri measures
    // size the same way as when remember_window_bounds captured them.
    window.set_shadow(true).map_err(|e| e.to_string())?;
    restore_saved_bounds(window)?;
    Ok(())
}

#[cfg(windows)]
fn window_fills_current_monitor(window: &WebviewWindow) -> Result<bool, String> {
    let size = window.outer_size().map_err(|e| e.to_string())?;
    let position = window.outer_position().map_err(|e| e.to_string())?;
    window_fills_monitor(window, size, position)
}

#[cfg(windows)]
fn window_fills_monitor(
    window: &WebviewWindow,
    size: PhysicalSize<u32>,
    position: PhysicalPosition<i32>,
) -> Result<bool, String> {
    let monitor = window
        .current_monitor()
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "No current monitor.".to_string())?;
    let mon_pos = monitor.position();
    let mon_size = monitor.size();

    const TOLERANCE_PX: i32 = 2;
    let width_match = (size.width as i32 - mon_size.width as i32).abs() <= TOLERANCE_PX;
    let height_match = (size.height as i32 - mon_size.height as i32).abs() <= TOLERANCE_PX;
    let x_match = (position.x - mon_pos.x).abs() <= TOLERANCE_PX;
    let y_match = (position.y - mon_pos.y).abs() <= TOLERANCE_PX;

    Ok(width_match && height_match && x_match && y_match)
}

#[cfg(windows)]
unsafe fn restore_under_cursor(hwnd: windows::Win32::Foundation::HWND) -> Result<(), String> {
    use windows::Win32::Foundation::{POINT, RECT};
    use windows::Win32::UI::WindowsAndMessaging::{
        GetCursorPos, GetWindowRect, SetWindowPos, SWP_FRAMECHANGED, SWP_NOZORDER,
    };

    let (restore_w, restore_h) = SAVED_WINDOW_BOUNDS
        .lock()
        .map_err(|e| e.to_string())?
        .map(|(size, _)| (size.width, size.height))
        .ok_or_else(|| "No saved window bounds.".to_string())?;

    let mut cursor = POINT::default();
    GetCursorPos(&mut cursor).map_err(|e| e.to_string())?;

    let mut window_rect = RECT::default();
    GetWindowRect(hwnd, &mut window_rect).map_err(|e| e.to_string())?;

    let window_width = window_rect.right - window_rect.left;
    let grab_x = cursor.x - window_rect.left;
    let grab_y = cursor.y - window_rect.top;

    let ratio = if window_width > 0 {
        grab_x as f64 / f64::from(window_width)
    } else {
        0.5
    };
    let new_left = cursor.x - (ratio * f64::from(restore_w)).round() as i32;
    let new_top = cursor.y - grab_y;

    SetWindowPos(
        hwnd,
        None,
        new_left,
        new_top,
        restore_w as i32,
        restore_h as i32,
        SWP_NOZORDER | SWP_FRAMECHANGED,
    )
    .map_err(|e| e.to_string())?;

    if let Some(window) = main_window() {
        window.set_shadow(true).map_err(|e| e.to_string())?;
    }

    Ok(())
}

#[cfg(windows)]
unsafe extern "system" fn fullscreen_drag_subclass(
    hwnd: windows::Win32::Foundation::HWND,
    msg: u32,
    wparam: windows::Win32::Foundation::WPARAM,
    lparam: windows::Win32::Foundation::LPARAM,
    _id: usize,
    _data: usize,
) -> windows::Win32::Foundation::LRESULT {
    use windows::Win32::UI::Shell::DefSubclassProc;
    use windows::Win32::UI::WindowsAndMessaging::{HTCAPTION, WM_NCLBUTTONDOWN};

    if msg == WM_NCLBUTTONDOWN && wparam.0 == HTCAPTION as usize {
        if let Ok(mut app_fs) = APP_FULLSCREEN.lock() {
            if *app_fs && restore_under_cursor(hwnd).is_ok() {
                *app_fs = false;
            }
        }
    }

    DefSubclassProc(hwnd, msg, wparam, lparam)
}