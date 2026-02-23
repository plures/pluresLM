#!/usr/bin/env node
/**
 * PluresLM OpenClaw Setup - One-command installation
 * Usage: npx @plures/pluresLM openclaw
 */

const { execSync, spawn } = require('child_process');
const path = require('path');

console.log('🧠 PluresLM OpenClaw Setup');
console.log('==========================\n');

async function runCommand(cmd, description) {
  console.log(`⏳ ${description}...`);
  try {
    const result = execSync(cmd, { 
      encoding: 'utf8', 
      stdio: ['inherit', 'pipe', 'pipe']
    });
    console.log(`✅ ${description} completed`);
    return result;
  } catch (error) {
    console.log(`❌ ${description} failed:`);
    console.log(error.message);
    if (error.stdout) console.log('STDOUT:', error.stdout);
    if (error.stderr) console.log('STDERR:', error.stderr);
    throw error;
  }
}

async function setupPluresLM() {
  try {
    // 1. Check if OpenClaw is installed
    console.log('1️⃣ Checking OpenClaw installation...');
    try {
      await runCommand('openclaw --version', 'OpenClaw version check');
    } catch (error) {
      console.log('\n❌ OpenClaw not found! Please install OpenClaw first:');
      console.log('   npm install -g openclaw');
      console.log('   # or follow: https://openclaw.ai/install');
      process.exit(1);
    }

    // 2. Install pluresLM plugin
    console.log('\n2️⃣ Installing PluresLM plugin...');
    const pluginPath = path.dirname(__dirname); // Parent of scripts/ directory
    
    // Add plugin to OpenClaw
    try {
      await runCommand(
        `openclaw config set plugins.load.paths '["${pluginPath}"]' --merge-arrays`,
        'Adding plugin path'
      );
    } catch (error) {
      // Fallback to direct path addition
      console.log('⚠️  Trying alternative plugin installation...');
      await runCommand(
        `openclaw config get plugins.load.paths || openclaw config set plugins.load.paths '[]'`,
        'Initialize plugin paths'
      );
      await runCommand(
        `openclaw config set plugins.load.paths.0 "${pluginPath}"`,
        'Set plugin path'
      );
    }

    // 3. Enable the plugin
    console.log('\n3️⃣ Enabling PluresLM plugin...');
    await runCommand(
      'openclaw config set plugins.entries.pluresLM.enabled true',
      'Enable pluresLM plugin'
    );

    // 4. Disable memory-core to prevent conflicts
    console.log('\n4️⃣ Configuring memory system...');
    await runCommand(
      'openclaw config set hooks.internal.entries.session-memory.enabled false',
      'Disable memory-core (prevent conflicts)'
    );

    // 5. Configure safe defaults
    console.log('\n5️⃣ Setting up safe defaults...');
    await runCommand(
      'openclaw config set plugins.entries.pluresLM.config.autoCapture false',
      'Disable auto-capture (can enable later)'
    );
    await runCommand(
      'openclaw config set plugins.entries.pluresLM.config.autoRecall false', 
      'Disable auto-recall (can enable later)'
    );

    // 6. Restart gateway
    console.log('\n6️⃣ Restarting OpenClaw gateway...');
    await runCommand('openclaw gateway restart', 'Gateway restart');
    
    // Give it a moment to start up
    console.log('⏳ Waiting for gateway to initialize...');
    await new Promise(resolve => setTimeout(resolve, 3000));

    // 7. Verify installation
    console.log('\n7️⃣ Verifying installation...');
    try {
      await runCommand('openclaw status', 'Status check');
      
      console.log('\n🎉 SUCCESS! PluresLM is now installed and running!');
      console.log('\n📋 Next steps:');
      console.log('   • Test with: openclaw chat "Remember: I like TypeScript"');
      console.log('   • Enable features: openclaw config set plugins.entries.pluresLM.config.autoCapture true');
      console.log('   • View status: openclaw status');
      console.log('   • Documentation: https://github.com/plures/pluresLM');
      
    } catch (error) {
      console.log('\n⚠️  Installation completed but verification failed.');
      console.log('   Try: openclaw status');
      console.log('   If issues persist, check: openclaw logs');
    }

  } catch (error) {
    console.log('\n❌ Installation failed!');
    console.log('\nError:', error.message);
    console.log('\n🔧 Manual installation:');
    console.log('   1. openclaw config set plugins.entries.pluresLM.enabled true');
    console.log('   2. openclaw config set hooks.internal.entries.session-memory.enabled false');
    console.log('   3. openclaw gateway restart');
    process.exit(1);
  }
}

// Check command line args
const args = process.argv.slice(2);
if (args.length === 0 || args[0] === 'openclaw') {
  setupPluresLM();
} else {
  console.log('Usage: npx @plures/pluresLM openclaw');
  console.log('   or: pluresLM openclaw');
  process.exit(1);
}