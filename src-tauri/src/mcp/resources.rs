use std::collections::HashMap;
use std::path::{Path, PathBuf};

/// Index of compendium files for MCP resource serving.
pub struct CompendiumIndex {
    /// Map of URI → file path
    files: HashMap<String, PathBuf>,
}

impl CompendiumIndex {
    /// Scan the compendium directory and build the index.
    pub fn new() -> Self {
        let mut files = HashMap::new();
        if let Some(base) = Self::compendium_dir() {
            if base.exists() {
                Self::scan_dir(&base, &base, &mut files);
                eprintln!(
                    "[Structs MCP] Compendium loaded: {} resources from {}",
                    files.len(),
                    base.display()
                );
            } else {
                eprintln!(
                    "[Structs MCP] Compendium not found at {} (run 'make sync' to install)",
                    base.display()
                );
            }
        }
        Self { files }
    }

    fn compendium_dir() -> Option<PathBuf> {
        dirs::config_dir().map(|d| d.join("structs-app").join("compendium"))
    }

    fn scan_dir(base: &Path, dir: &Path, files: &mut HashMap<String, PathBuf>) {
        let Ok(entries) = std::fs::read_dir(dir) else {
            return;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                Self::scan_dir(base, &path, files);
            } else if path.extension().map(|e| e == "md").unwrap_or(false) {
                // Build URI from relative path: structs://knowledge/combat.md
                if let Ok(rel) = path.strip_prefix(base) {
                    let uri = format!("structs://{}", rel.display());
                    files.insert(uri, path);
                }
            }
        }
    }

    /// List all resources with their URIs and descriptions.
    pub fn list_all(&self) -> Vec<(String, String, String)> {
        let mut resources: Vec<_> = self
            .files
            .iter()
            .map(|(uri, path)| {
                let name = path
                    .file_stem()
                    .map(|s| s.to_string_lossy().to_string())
                    .unwrap_or_default();
                let description = path
                    .parent()
                    .and_then(|p| p.file_name())
                    .map(|s| format!("{}/{}", s.to_string_lossy(), name))
                    .unwrap_or_else(|| name.clone());
                (uri.clone(), name, description)
            })
            .collect();
        resources.sort_by(|a, b| a.0.cmp(&b.0));
        resources
    }

    /// Read a resource by URI.
    pub fn read_by_uri(&self, uri: &str) -> Option<String> {
        let path = self.files.get(uri)?;
        std::fs::read_to_string(path).ok()
    }

    pub fn is_empty(&self) -> bool {
        self.files.is_empty()
    }
}
