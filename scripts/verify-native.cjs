#!/usr/bin/env node
/**
 * Verify PluresDB native binary can be loaded from npm package
 */

const path = require('path');

console.log('Testing PluresDB native loading...');
console.log('Platform:', process.platform + '-' + process.arch);

try {
  // Try to load from npm package
  console.log('1. Trying npm package (@plures/pluresdb/embedded)...');
  const embedded = require('@plures/pluresdb/embedded');
  console.log('   ✅ npm package loaded');
  console.log('   exports:', Object.keys(embedded));
  
  if (embedded.PluresDatabase) {
    console.log('2. Testing PluresDatabase constructor...');
    const db = new embedded.PluresDatabase('test-actor');
    console.log('   ✅ PluresDatabase created successfully');
    
    console.log('3. Testing basic operations...');
    db.put('test', { value: 'hello' });
    const result = db.get('test');
    console.log('   ✅ put/get works:', result);
    
    console.log('\n✅ PluresDB native binary is working correctly!');
  } else {
    console.log('   ❌ PluresDatabase not found in exports');
  }
  
} catch (error) {
  console.log('   ❌ npm package failed:', error.message);
  
  // Fallback test for workspace
  console.log('\n2. Trying workspace fallback...');
  try {
    const workspacePath = path.resolve(__dirname, '..', '..', 'pluresdb', 'embedded.js');
    console.log('   workspace path:', workspacePath);
    
    const embedded = require(workspacePath);
    console.log('   ✅ workspace loaded');
    console.log('   exports:', Object.keys(embedded));
    
    if (embedded.PluresDatabase) {
      const db = new embedded.PluresDatabase('test-actor');
      db.put('test', { value: 'hello' });
      const result = db.get('test');
      console.log('   ✅ workspace test works:', result);
      console.log('\n✅ PluresDB working via workspace (dev mode)');
    }
  } catch (wsError) {
    console.log('   ❌ workspace also failed:', wsError.message);
    console.log('\n❌ PluresDB native binary not available');
    console.log('\nTo fix:');
    console.log('1. Publish updated PluresDB to npm with native binaries');
    console.log('2. Or build locally: cd pluresdb/crates/pluresdb-node && npm run build');
  }
}