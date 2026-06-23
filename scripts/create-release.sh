#!/usr/bin/env bash

set -euo pipefail

# Anvilwing Coder Release Script
# Creates a new release with proper versioning, changelog updates, and deployment preparation

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

log() {
  echo -e "${BLUE}[RELEASE]${NC} $1"
}

success() {
  echo -e "${GREEN}[SUCCESS]${NC} $1"
}

warning() {
  echo -e "${YELLOW}[WARNING]${NC} $1"
}

error() {
  echo -e "${RED}[ERROR]${NC} $1"
  exit 1
}

# Check prerequisites
check_prerequisites() {
  log "Checking prerequisites..."
  
  # Check Node.js
  if ! command -v node &> /dev/null; then
    error "Node.js is not installed"
  fi
  log "✓ Node.js $(node --version)"
  
  # Check npm
  if ! command -v npm &> /dev/null; then
    error "npm is not installed"
  fi
  log "✓ npm $(npm --version)"
  
  # Check git
  if ! command -v git &> /dev/null; then
    error "git is not installed"
  fi
  log "✓ git $(git --version | cut -d' ' -f3)"
  
  # Check clean git status
  if [[ -n "$(git status --porcelain)" ]]; then
    warning "Git working directory is not clean"
    read -p "Continue anyway? (y/N): " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
      error "Aborted by user"
    fi
  fi
  
  success "Prerequisites check passed"
}

# Run tests
run_tests() {
  log "Running test suite..."
  
  if ! npm test > /tmp/anvilwing-test-output.log 2>&1; then
    error "Tests failed. See /tmp/anvilwing-test-output.log for details"
  fi
  
  success "All tests passed"
}

# Build project
build_project() {
  log "Building project..."
  
  if ! npm run build > /tmp/anvilwing-build-output.log 2>&1; then
    error "Build failed. See /tmp/anvilwing-build-output.log for details"
  fi
  
  success "Build completed"
}

# Optimize build
optimize_build() {
  log "Optimizing build for production..."
  
  export NODE_ENV=production
  export MINIFY=true
  export REMOVE_DEBUG=true
  
  if ! node scripts/optimize-build.mjs > /tmp/anvilwing-optimize-output.log 2>&1; then
    error "Build optimization failed. See /tmp/anvilwing-optimize-output.log for details"
  fi
  
  success "Build optimization completed"
}

# Update changelog
update_changelog() {
  local version="$1"
  local release_notes="$2"
  
  log "Updating changelog for version $version..."
  
  # Create temporary changelog
  local temp_changelog=$(mktemp)
  
  # Write new version section
  echo "# Changelog" > "$temp_changelog"
  echo "" >> "$temp_changelog"
  echo "## [$version] - $(date +%Y-%m-%d)" >> "$temp_changelog"
  echo "" >> "$temp_changelog"
  echo "$release_notes" >> "$temp_changelog"
  echo "" >> "$temp_changelog"
  
  # Append existing changelog (excluding the unreleased section if exists)
  if [[ -f "CHANGELOG.md" ]]; then
    # Skip the first "Unreleased" section
    tail -n +3 "CHANGELOG.md" >> "$temp_changelog" 2>/dev/null || true
  fi
  
  # Replace original changelog
  mv "$temp_changelog" "CHANGELOG.md"
  
  success "Changelog updated"
}

# Create git tag
create_git_tag() {
  local version="$1"
  
  log "Creating git tag v$version..."
  
  if ! git add -A; then
    error "Failed to stage changes"
  fi
  
  local commit_message="Release v$version"
  if ! git commit -m "$commit_message"; then
    error "Failed to commit changes"
  fi
  
  if ! git tag -a "v$version" -m "$commit_message"; then
    error "Failed to create git tag"
  fi
  
  success "Created git tag v$version"
}

# Main release function
release() {
  local bump_type="${1:-patch}"
  local release_notes="${2:-}"
  
  log "Starting Anvilwing Coder release process..."
  
  # Check prerequisites
  check_prerequisites
  
  # Get current version
  local current_version=$(node -p "require('./package.json').version")
  log "Current version: $current_version"
  
  # Bump version
  log "Bumping $bump_type version..."
  local new_version=$(node -p "const semver = require('semver'); semver.inc('$current_version', '$bump_type')")
  
  if [[ -z "$new_version" ]]; then
    error "Failed to bump version. Valid types: patch, minor, major"
  fi
  
  log "New version: $new_version"
  
  # Run tests
  run_tests
  
  # Update package.json version
  if ! npm version "$new_version" --no-git-tag-version --allow-same-version; then
    error "Failed to update package.json version"
  fi
  
  # Build project
  build_project
  
  # Optimize build
  optimize_build
  
  # Update changelog
  if [[ -z "$release_notes" ]]; then
    release_notes="### Features\n- Update release $new_version\n\n### Bug Fixes\n- Minor improvements and optimizations"
  fi
  update_changelog "$new_version" "$release_notes"
  
  # Create git tag
  create_git_tag "$new_version"
  
  # Summary
  echo ""
  success "Anvilwing Coder v$new_version release prepared successfully!"
  echo ""
  log "Next steps:"
  log "1. Review changes: git show"
  log "2. Push changes: git push origin main --follow-tags"
  log "3. Create GitHub release: gh release create v$new_version"
  log "4. Publish to npm: npm publish"
  echo ""
}

# Parse command line arguments
case "${1:-}" in
  patch|minor|major)
    release "$1" "${2:-}"
    ;;
  -h|--help|help)
    echo "Anvilwing Coder Release Script"
    echo ""
    echo "Usage:"
    echo "  $0 [patch|minor|major] [release_notes]"
    echo ""
    echo "Examples:"
    echo "  $0 patch                          # Create patch release"
    echo "  $0 minor \"Added new features\"    # Create minor release with notes"
    echo "  $0 major                          # Create major release"
    echo ""
    exit 0
    ;;
  *)
    echo "Usage: $0 [patch|minor|major] [release_notes]"
    echo "Use -h for help"
    exit 1
    ;;
esac