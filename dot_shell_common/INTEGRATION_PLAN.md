# Dotfiles Test Suite Integration Plan

## Project Overview
Complete integration of `dotfiles_doctor.sh` functionality into the unified `test_suite.sh` using adapter pattern architecture.

## Current Status ✅
- [x] **Phase 1: Foundation Architecture Complete**
  - [x] Adapter pattern implementation
  - [x] Environment auto-detection (pre/post apply)
  - [x] Modular test engine with categories
  - [x] Comprehensive reporting system
  - [x] CI integration updated
  - [x] Legacy compatibility maintained
  - **Commit**: `4db618c` - Foundation complete with project CLAUDE.md

## Phase 2: Core Integration 🚧
**Objective**: Merge dotfiles_doctor.sh's 120+ comprehensive checks into test_suite.sh

### Analysis Complete ✅
- [x] **dotfiles_doctor.sh Analysis**
  - 120+ detailed check items
  - 80% environment-independent (commands, versions, dependencies)
  - 20% environment-dependent (file paths, configurations)
  - Superior UX: priority classification, weighted scoring, install hints

### Tasks Remaining
- [ ] **2.1: Extract Core Functions**
  - [ ] `check_command()` with priority/weight system
  - [ ] `check_command_with_deps()` for dependency chains
  - [ ] `check_path()` with adapter-aware path resolution
  - [ ] `check_env()` for environment variables
  - [ ] Priority system: required/recommended/optional
  - [ ] Weight system: WEIGHT_REQUIRED=10, WEIGHT_RECOMMENDED=5, WEIGHT_OPTIONAL=1

- [ ] **2.2: Integrate Advanced Features**
  - [ ] OS-specific package management checks (apt/brew/winget)
  - [ ] Version managers (mise, asdf, direnv)
  - [ ] Programming languages & runtimes (node, go, rust, python)
  - [ ] Development tools (starship, gh, ghq, ripgrep, fzf, bat, jq)
  - [ ] Text editors (vim, vscode)
  - [ ] Security tools (1password, age, gpg)

- [ ] **2.3: Enhanced Validation**
  - [ ] Git configuration validation (user.name, user.email, GPG signing)
  - [ ] Chezmoi status and repository health
  - [ ] Shell function and alias validation
  - [ ] Directory structure validation ($HOME/.local/bin, .config, etc.)

- [ ] **2.4: Comprehensive Reporting**
  - [ ] Weighted health scoring system
  - [ ] Detailed install hints with OS-specific commands
  - [ ] Actionable recommendations based on missing components
  - [ ] Summary with ready/not-ready status for chezmoi apply

## Phase 3: Adapter Enhancement 🔄
**Objective**: Improve adapter pattern to handle all environment variations

### Tasks
- [ ] **3.1: Enhanced Path Resolution**
  - [ ] Support for XDG_CONFIG_HOME variations
  - [ ] ZDOTDIR-aware zsh configuration detection
  - [ ] Windows PowerShell profile support
  - [ ] macOS-specific paths and tools

- [ ] **3.2: Advanced Environment Detection**
  - [ ] CI environment improvements (GitHub Actions, GitLab CI, etc.)
  - [ ] Container environment detection
  - [ ] Remote development environment support (Codespaces, DevPod)

- [ ] **3.3: Cross-Platform Compatibility**
  - [ ] Windows PowerShell adapter
  - [ ] macOS-specific tool detection
  - [ ] Linux distribution variations (Ubuntu, CentOS, Arch, etc.)

## Phase 4: Legacy Cleanup 🧹
**Objective**: Complete migration from old system

### Tasks
- [ ] **4.1: Feature Parity Verification**
  - [ ] Compare old vs new test coverage
  - [ ] Verify all dotfiles_doctor.sh functionality preserved
  - [ ] Performance comparison and optimization

- [ ] **4.2: Migration**
  - [ ] Remove `dotfiles_doctor.sh` (keep as backup initially)
  - [ ] Update `executable_doctor` to be full wrapper
  - [ ] Update documentation and usage examples

- [ ] **4.3: Testing & Validation**
  - [ ] Comprehensive testing in both pre/post apply modes
  - [ ] CI pipeline validation
  - [ ] Performance benchmarking
  - [ ] User acceptance testing

## Success Criteria
### Functional Requirements
- [ ] **120+ comprehensive checks** (matching dotfiles_doctor.sh)
- [ ] **Weighted scoring system** with meaningful health percentages
- [ ] **Priority classification** (required/recommended/optional)
- [ ] **OS-specific support** (Linux/macOS/Windows)
- [ ] **Detailed install hints** with copy-paste commands
- [ ] **Pre/post apply mode** automatic detection and adaptation

### Technical Requirements
- [ ] **Performance**: < 5 seconds for full test suite
- [ ] **Reliability**: 100% consistent results across environments
- [ ] **Maintainability**: Clean modular architecture
- [ ] **Extensibility**: Easy addition of new test categories

### User Experience Requirements
- [ ] **Intuitive**: Clear status and actionable feedback
- [ ] **Comprehensive**: No manual checks needed
- [ ] **Flexible**: Support for targeted test categories
- [ ] **Informative**: Detailed verbose mode for debugging

## Risk Mitigation
- **Backup Strategy**: Keep original files until full validation
- **Incremental Approach**: Phase-by-phase integration with testing
- **Fallback Plan**: Legacy wrapper ensures continuity
- **Version Control**: Detailed commit history for rollback capability

## Next Immediate Tasks
1. **Extract and adapt check_command functions** from dotfiles_doctor.sh
2. **Implement priority and weight system** in test_engine.sh
3. **Integrate OS detection and package manager checks**
4. **Test integration with existing adapter pattern**

---
*Document Updated: 2025-08-11*
*Current Phase: 2 (Core Integration)*
*Next Milestone: Complete check function integration*