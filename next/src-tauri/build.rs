fn main() {
    println!("cargo:rerun-if-env-changed=PANEFORGE_UPDATE_ENDPOINT");
    println!("cargo:rerun-if-env-changed=PANEFORGE_UPDATE_PUBLIC_KEY");
    tauri_build::build()
}
