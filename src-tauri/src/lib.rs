use std::{env, fs, path::PathBuf, process::Command, sync::Mutex};
use tauri::{Emitter, Manager};
use url::Url;

struct OpenedUrls(Mutex<Vec<Url>>);

#[cfg(target_os = "macos")]
fn cleanup_regenerable_webkit_data() {
    let Some(home) = env::var_os("HOME") else {
        return;
    };
    let library = PathBuf::from(home).join("Library");
    let website_data = library
        .join("WebKit")
        .join("com.localepub.reader")
        .join("WebsiteData");

    // The hashed Default directory contains the EPUB library and reading data.
    // Only remove WebKit data that can be recreated without losing user content.
    for path in [
        library.join("Caches").join("com.localepub.reader"),
        website_data.join("ResourceLoadStatistics"),
        website_data.join("SearchHistory"),
    ] {
        if let Err(error) = fs::remove_dir_all(&path) {
            if error.kind() != std::io::ErrorKind::NotFound {
                eprintln!("Could not clean WebKit cache at {}: {error}", path.display());
            }
        }
    }
}

#[cfg(not(target_os = "macos"))]
fn cleanup_regenerable_webkit_data() {}

fn to_path(input: &str) -> Result<PathBuf, String> {
    if input.starts_with("file://") {
        let url = Url::parse(input).map_err(|error| error.to_string())?;
        return url
            .to_file_path()
            .map_err(|_| "Could not convert file URL to a local path".to_string());
    }

    Ok(PathBuf::from(input))
}

#[tauri::command]
fn read_epub_file(path: String) -> Result<Vec<u8>, String> {
    let path = to_path(&path)?;
    fs::read(&path).map_err(|error| error.to_string())
}

#[tauri::command]
fn store_epub_file(file_name: String, book_id: String, bytes: Vec<u8>) -> Result<String, String> {
    let home = env::var_os("HOME").ok_or_else(|| "Could not locate the home directory".to_string())?;
    let books_dir = PathBuf::from(home).join("Documents").join("myEPUB").join("Books");
    fs::create_dir_all(&books_dir).map_err(|error| error.to_string())?;

    let safe_name: String = file_name
        .chars()
        .map(|character| match character {
            '/' | '\\' | ':' => '_',
            _ => character,
        })
        .collect();
    let stem = safe_name.strip_suffix(".epub").or_else(|| safe_name.strip_suffix(".EPUB")).unwrap_or(&safe_name);
    let short_id: String = book_id.chars().take(8).collect();
    let path = books_dir.join(format!("{stem} [{short_id}].epub"));
    let temporary_path = path.with_extension("epub.tmp");
    fs::write(&temporary_path, &bytes).map_err(|error| error.to_string())?;
    let written_size = fs::metadata(&temporary_path).map_err(|error| error.to_string())?.len();
    if written_size != bytes.len() as u64 {
        let _ = fs::remove_file(&temporary_path);
        return Err("The EPUB file was not written completely".to_string());
    }
    fs::rename(&temporary_path, &path).map_err(|error| error.to_string())?;

    Ok(path.to_string_lossy().into_owned())
}

#[tauri::command]
fn reveal_epub_file(path: String) -> Result<(), String> {
    let path = to_path(&path)?;
    if !path.is_file() {
        return Err("The stored EPUB file could not be found".to_string());
    }

    #[cfg(target_os = "macos")]
    {
        let status = Command::new("open")
            .arg("-R")
            .arg(&path)
            .status()
            .map_err(|error| error.to_string())?;
        if !status.success() {
            return Err("Finder could not reveal the exported book".to_string());
        }
    }

    Ok(())
}

#[tauri::command]
fn delete_epub_file(path: String) -> Result<(), String> {
    let path = to_path(&path)?;
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.to_string()),
    }
}

#[tauri::command]
fn opened_urls(app: tauri::AppHandle) -> Vec<Url> {
    app.state::<OpenedUrls>().0.lock().unwrap().clone()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    cleanup_regenerable_webkit_data();

    tauri::Builder::default()
        .manage(OpenedUrls(Mutex::new(vec![])))
        .invoke_handler(tauri::generate_handler![
            read_epub_file,
            store_epub_file,
            reveal_epub_file,
            delete_epub_file,
            opened_urls,
        ])
        .build(tauri::generate_context!())
        .expect("error while running myEPUB")
        .run(|app, event| {
            if let tauri::RunEvent::Opened { urls } = event {
                app.state::<OpenedUrls>()
                    .0
                    .lock()
                    .unwrap()
                    .extend(urls.clone());

                if let Err(error) = app.emit("opened", urls) {
                    eprintln!("Could not emit opened file event: {error}");
                }
            }
        });
}
