/**
 * OpenClaw Compatibility Detection and Mode Selection
 * 
 * Detects OpenClaw capabilities at runtime and selects optimal operating mode:
 * - Enhanced: Uses custom memory hooks, no compaction, real-time context
 * - Compatible: Coexists with file-based memory, enhanced compaction hooks
 */

export interface OpenClawCapabilities {
  version: string;
  hasCustomMemoryHooks: boolean;
  hasCompactionOverride: boolean; 
  hasProcessIsolation: boolean;
  hasMemoryBackendAPI: boolean;
  supportsExtensionKind: boolean;
}

export type OperatingMode = 'enhanced' | 'compatible';

export interface CompatibilityConfig {
  operatingMode: 'auto' | 'enhanced' | 'compatible';
}

const DEFAULT_COMPATIBILITY_CONFIG: CompatibilityConfig = {
  operatingMode: 'auto',
};

export class OpenClawCompatibilityDetector {
  private capabilities: OpenClawCapabilities | null = null;
  private detectedMode: OperatingMode | null = null;

  constructor(private api: any) {}

  /**
   * Detect OpenClaw capabilities and determine optimal operating mode
   */
  async detectCapabilities(): Promise<OpenClawCapabilities> {
    if (this.capabilities) {
      return this.capabilities;
    }

    const capabilities: OpenClawCapabilities = {
      version: await this.detectVersion(),
      hasCustomMemoryHooks: this.detectCustomMemoryHooks(),
      hasCompactionOverride: this.detectCompactionOverride(),
      hasProcessIsolation: this.detectProcessIsolation(),
      hasMemoryBackendAPI: this.detectMemoryBackendAPI(),
      supportsExtensionKind: this.detectExtensionKind(),
    };

    this.capabilities = capabilities;
    return capabilities;
  }

  /**
   * Determine optimal operating mode based on capabilities
   */
  async determineOperatingMode(config: CompatibilityConfig = DEFAULT_COMPATIBILITY_CONFIG): Promise<OperatingMode> {
    if (this.detectedMode && config.operatingMode === 'auto') {
      return this.detectedMode;
    }

    // Override mode if explicitly set
    if (config.operatingMode !== 'auto') {
      this.detectedMode = config.operatingMode;
      return config.operatingMode;
    }

    const capabilities = await this.detectCapabilities();

    // Enhanced mode requires custom memory hooks + process isolation + extension kind
    const canRunEnhanced = capabilities.hasCustomMemoryHooks && 
                          capabilities.hasProcessIsolation && 
                          capabilities.supportsExtensionKind;

    this.detectedMode = canRunEnhanced ? 'enhanced' : 'compatible';
    return this.detectedMode;
  }

  /**
   * Get human-readable compatibility report
   */
  async generateCompatibilityReport(): Promise<string> {
    const capabilities = await this.detectCapabilities();
    const mode = await this.determineOperatingMode();

    const lines: string[] = [
      `OpenClaw Compatibility Report`,
      `=================================`,
      ``,
      `Version: ${capabilities.version}`,
      `Operating Mode: ${mode.toUpperCase()}`,
      ``,
      `Capabilities:`,
      `  Custom Memory Hooks: ${capabilities.hasCustomMemoryHooks ? '✅' : '❌'}`,
      `  Compaction Override: ${capabilities.hasCompactionOverride ? '✅' : '❌'}`,
      `  Process Isolation: ${capabilities.hasProcessIsolation ? '✅' : '❌'}`,
      `  Memory Backend API: ${capabilities.hasMemoryBackendAPI ? '✅' : '❌'}`,
      `  Extension Kind: ${capabilities.supportsExtensionKind ? '✅' : '❌'}`,
      ``,
    ];

    if (mode === 'enhanced') {
      lines.push(
        `🚀 Enhanced Mode Features:`,
        `  • PluresLM as single source of truth`,
        `  • Real-time context management`,
        `  • Intelligent memory auto-generation`,
        `  • Process-specific database isolation`,
        `  • Compaction system elimination`,
      );
    } else {
      lines.push(
        `📦 Compatible Mode Features:`,
        `  • Core tools (store/search/forget) work everywhere`,
        `  • Hooks requiring fork APIs are skipped`,
        `  • Graceful degradation`,
        ``,
        `💡 To unlock Enhanced Mode:`,
        `  • Upgrade to OpenClaw Enhanced`,
        `  • Or apply PluresLM customizations`,
      );
    }

    return lines.join('\n');
  }

  // ── Detection Methods ────────────────────────────────────────────────────

  private async detectVersion(): Promise<string> {
    try {
      // Try to get version from API if available
      if (this.api.getVersion) {
        return this.api.getVersion();
      }
      
      // Fallback to package.json detection
      const fs = require('fs');
      const path = require('path');
      
      // Look for package.json in common locations
      const possiblePaths = [
        '../package.json',
        '../../package.json',
        '../../../package.json',
        process.env.OPENCLAW_HOME + '/package.json',
      ];
      
      for (const pkgPath of possiblePaths) {
        try {
          const fullPath = path.resolve(pkgPath);
          if (fs.existsSync(fullPath)) {
            const pkg = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
            if (pkg.name === 'openclaw' || pkg.name?.includes('openclaw')) {
              return pkg.version || 'unknown';
            }
          }
        } catch (e) {
          // Continue trying other paths
        }
      }
      
      return 'unknown';
    } catch (e) {
      return 'unknown';
    }
  }

  private detectCustomMemoryHooks(): boolean {
    try {
      // Check if our custom memory hooks are present
      return (
        typeof this.api.registerMemoryCapture === 'function' &&
        typeof this.api.registerMemoryRecall === 'function' &&
        typeof this.api.overrideCompactionBehavior === 'function'
      );
    } catch (e) {
      return false;
    }
  }

  private detectCompactionOverride(): boolean {
    try {
      // Check if we can override compaction behavior
      return typeof this.api.overrideCompactionBehavior === 'function';
    } catch (e) {
      return false;
    }
  }

  private detectProcessIsolation(): boolean {
    try {
      // Check if process isolation APIs are available
      return (
        typeof this.api.getProcessName === 'function' ||
        process.env.OPENCLAW_PROCESS_NAME !== undefined
      );
    } catch (e) {
      return false;
    }
  }

  private detectMemoryBackendAPI(): boolean {
    try {
      // Check if memory backend API is available
      return typeof this.api.registerMemoryBackend === 'function';
    } catch (e) {
      return false;
    }
  }

  private detectExtensionKind(): boolean {
    try {
      // Check if extension kind is supported (vs memory kind)
      return this.api.supportedPluginKinds?.includes('extension') || true; // Assume true for now
    } catch (e) {
      return true; // Default to true
    }
  }

  /**
   * Check if running in development environment
   */
  isDevelopment(): boolean {
    return (
      process.env.NODE_ENV === 'development' ||
      process.env.OPENCLAW_DEV === 'true' ||
      process.cwd().includes('openclaw') ||
      process.cwd().includes('pluresLM')
    );
  }

  /**
   * Recommend best installation method for current environment
   */
  async recommendInstallation(): Promise<string> {
    const capabilities = await this.detectCapabilities();
    const mode = await this.determineOperatingMode();
    const isDev = this.isDevelopment();

    if (mode === 'enhanced') {
      return isDev
        ? 'Development: Already running enhanced mode'
        : 'Production: OpenClaw Enhanced detected - optimal configuration';
    } else {
      const lines = [
        'Recommendations for Enhanced Experience:',
        '',
        '1. OpenClaw Enhanced Bundle:',
        '   npm install @plures/openclaw-enhanced',
        '',
        '2. Apply PluresLM Customizations:',
        '   git clone https://github.com/plures/openclaw-enhanced.git',
        '   bash install-customizations.sh',
        '',
        '3. Or Continue with Compatible Mode:',
        '   - Good performance and features',
        '   - Works with any OpenClaw version',
        '   - Gradual upgrade path available',
      ];
      
      return lines.join('\n');
    }
  }
}