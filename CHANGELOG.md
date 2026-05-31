# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2026-05-05

### Added
- Left vertical navigation panel for admin and partner modules, replacing the horizontal card grid
- User management table with avatar, role badge, status indicator, and action columns
- Modal-based CRUD flows for users: create, edit, deactivate/activate, force password change, delete
- Roles sub-view with modal for creating a role including permissions configuration in a single step
- Toast notification system (success/danger/warning/info) replacing browser alerts
- Confirmation modals before destructive operations (delete user, delete client, activate voucher, save permissions)
- Logout dropdown on the username in the header
- Role-based navigation panel for partner role (same structure as admin)
- `VERSION` file for semantic versioning tracking
- `.env.example` template for environment variable documentation
- `.gitignore` with comprehensive rules for secrets, dependencies, build artifacts, and CI/CD files

### Changed
- Users section reorganized: list view and roles view are now separate sub-tabs
- Admin and partner sections break out of the app-shell max-width constraint for full-width panel layout
- Role creation now includes permission configuration inline within the creation modal
- All `confirm()` dialogs replaced with Bootstrap modals
- All inline alert messages replaced with toast notifications

### Removed
- CI/CD deployment configuration (`docker-compose.prod.yml`, GitHub Actions deploy workflows)
- Horizontal card grid navigation at the top of admin and partner sections
- Inline role creation form (replaced by modal)
- `simulate_payment.ps1`, `test-sync-events.ps1`, `test_admin_login.js` excluded via `.gitignore`
