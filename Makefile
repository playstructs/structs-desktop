.PHONY: dev build sync clean release sign help check tag

help: ## Show this help
	@echo "Structs Universe — Desktop App"
	@echo ""
	@echo "Local development:"
	@grep -E '^(dev|build|sync|clean|release|sign|launch|check|test):.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-15s\033[0m %s\n", $$1, $$2}'
	@echo ""
	@echo "Release (CI builds for macOS, Windows, Linux):"
	@grep -E '^(tag|launch-debug):.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-15s\033[0m %s\n", $$1, $$2}'
	@echo ""
	@echo "To create a multi-platform release:"
	@echo "  1. make tag v=0.2.0"
	@echo "  2. git push origin v0.2.0"
	@echo "  3. GitHub Actions builds .app (macOS), .exe/.msi (Windows), .deb/.AppImage (Linux)"
	@echo "  4. Download from GitHub Releases"

dev: ## Launch in development mode (hot reload, devtools enabled)
	cargo tauri dev

sync: ## Pull latest structs-webapp + structs-ai and rebuild frontend
	git submodule update --remote structs-webapp structs-ai
	npm run sync

build: ## Production build + code sign
	rm -f src-tauri/target/release/bundle/macos/rw.*.dmg
	-npm run tauri:build
	bash scripts/sign.sh

clean: ## Remove build artifacts
	cd src-tauri && cargo clean
	rm -rf .build-tmp
	rm -rf frontend/js frontend/css frontend/fonts frontend/img frontend/lottie frontend/structicons

release: sync build ## Full rebuild: pull latest webapp + build + sign
	@echo ""
	@echo "Release build complete:"
	@echo "  src-tauri/target/release/bundle/macos/Structs.app"

sign: ## Re-sign the existing .app bundle
	bash scripts/sign.sh

launch: ## Launch the signed release bundle
	open src-tauri/target/release/bundle/macos/Structs.app

launch-debug: ## Launch release bundle from terminal (shows stderr)
	src-tauri/target/release/bundle/macos/Structs.app/Contents/MacOS/structs-app

check: ## Check Rust compilation without building
	cd src-tauri && cargo check

test: ## Run Rust tests
	cd src-tauri && cargo test

tag: ## Create a release tag (usage: make tag v=0.2.0)
	@if [ -z "$(v)" ]; then echo "Usage: make tag v=0.2.0"; exit 1; fi
	git tag -a "v$(v)" -m "Release v$(v)"
	@echo "Tag v$(v) created. Push with: git push origin v$(v)"
	@echo "This will trigger the GitHub Actions release build for macOS, Windows, and Linux."
