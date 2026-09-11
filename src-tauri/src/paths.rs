use std::fs;
use std::path::PathBuf;

/// データの置き場所を決める。
///
/// exe と同じ階層に書き込み可能な `data/` があればそれを使う (ポータブルモード)。
/// 会社の PC などで exe 隣に書けない場合は `%LOCALAPPDATA%\PomoSingle\` に退避する。
pub fn data_dir() -> PathBuf {
    if let Some(portable) = portable_dir() {
        return portable;
    }
    let base = std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir);
    let dir = base.join("PomoSingle");
    let _ = fs::create_dir_all(&dir);
    dir
}

fn portable_dir() -> Option<PathBuf> {
    let dir = std::env::current_exe().ok()?.parent()?.join("data");
    if dir.is_dir() && is_writable(&dir) {
        Some(dir)
    } else {
        None
    }
}

/// 実際に書いてみて確かめる。ACL や読み取り専用ボリュームを事前判定するのは
/// Windows では当てにならないため。
fn is_writable(dir: &PathBuf) -> bool {
    let probe = dir.join(".write-probe");
    match fs::write(&probe, b"") {
        Ok(()) => {
            let _ = fs::remove_file(&probe);
            true
        }
        Err(_) => false,
    }
}

pub fn db_path() -> PathBuf {
    data_dir().join("pomosingle.db")
}
