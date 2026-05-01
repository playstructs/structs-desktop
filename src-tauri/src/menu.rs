use tauri::menu::{AboutMetadataBuilder, Menu, MenuBuilder, SubmenuBuilder};
use tauri::{AppHandle, Runtime};

const ABOUT_COMMENTS: &str = "In the distant future the species of the galaxy are embroiled in a race for Alpha Matter, the rare and dangerous substance that fuels galactic civilization. Players take command of Structs, a race of sentient machines, and must forge alliances, conquer enemies and expand their influence to control Alpha Matter and the fate of the galaxy.\n\nStructs is a decentralized game in the Cosmos ecosystem, operated and governed by our community of players — ensuring Structs remains online as long as there are players to play it.";

pub fn build<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let about = AboutMetadataBuilder::new()
        .name(Some("Structs"))
        .version(Some(env!("CARGO_PKG_VERSION")))
        .short_version(Some(env!("CARGO_PKG_VERSION")))
        .copyright(Some("© Slow Ninja Inc."))
        .website(Some("https://playstructs.com"))
        .website_label(Some("playstructs.com"))
        .comments(Some(ABOUT_COMMENTS))
        .build();

    #[cfg(target_os = "macos")]
    {
        let app_menu = SubmenuBuilder::new(app, "Structs")
            .about(Some(about))
            .separator()
            .services()
            .separator()
            .hide()
            .hide_others()
            .show_all()
            .separator()
            .quit()
            .build()?;

        let edit_menu = SubmenuBuilder::new(app, "Edit")
            .undo()
            .redo()
            .separator()
            .cut()
            .copy()
            .paste()
            .select_all()
            .build()?;

        let view_menu = SubmenuBuilder::new(app, "View").fullscreen().build()?;

        let window_menu = SubmenuBuilder::new(app, "Window")
            .minimize()
            .separator()
            .close_window()
            .build()?;

        return MenuBuilder::new(app)
            .items(&[&app_menu, &edit_menu, &view_menu, &window_menu])
            .build();
    }

    #[cfg(not(target_os = "macos"))]
    {
        let help_menu = SubmenuBuilder::new(app, "Help").about(Some(about)).build()?;
        MenuBuilder::new(app).items(&[&help_menu]).build()
    }
}
