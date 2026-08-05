document.addEventListener('DOMContentLoaded', () => {
  const colorInputs = document.querySelectorAll('.color-picker-modern');
  if (colorInputs.length === 0) return;

  const presetColors = [
    '#7c5cfc', '#3b82f6', '#06b6d4', '#10b981', 
    '#8b5cf6', '#d946ef', '#f43f5e', '#f59e0b',
    '#0f172a', '#1e293b', '#334155', '#ffffff'
  ];

  const modalHTML = `
    <div id="modernColorPicker" class="modal-overlay" style="z-index: 10005;">
      <div class="modal" style="display:flex; flex-direction:column; padding: 24px; width: 320px; border-radius: 24px; margin: auto;">
        <h4 style="margin-top: 0; margin-bottom: 20px; color: var(--text); text-align: center; font-size: 1.1rem;">Choose Color</h4>
        
        <div style="display: grid; grid-template-columns: repeat(4, 1fr); gap: 16px; margin-bottom: 24px;">
          ${presetColors.map(c => `
            <div class="color-swatch-preset" data-color="${c}" style="background-color: ${c}; width: 100%; aspect-ratio: 1; border-radius: 50%; cursor: pointer; border: 2px solid rgba(255,255,255,0.1); box-shadow: 0 4px 10px rgba(0,0,0,0.15); transition: transform 0.2s cubic-bezier(0.34, 1.56, 0.64, 1);"></div>
          `).join('')}
        </div>

        <div style="margin-bottom: 24px;">
          <label style="font-size: 0.8rem; color: var(--text-secondary); margin-bottom: 8px; display: block; font-weight: 500;">Custom Hex</label>
          <div style="display: flex; gap: 12px;">
            <div id="colorPreview" style="width: 44px; height: 44px; border-radius: 12px; border: 1px solid var(--border-soft); box-shadow: inset 0 2px 4px rgba(0,0,0,0.1);"></div>
            <input type="text" id="hexInput" class="form-input" style="flex: 1; text-transform: uppercase; font-family: monospace; font-size: 1rem; letter-spacing: 1px; height: 44px;" placeholder="#FFFFFF">
          </div>
        </div>

        <div style="display:flex; gap: 12px; width: 100%;">
          <button id="mcpCancel" style="flex: 1; padding: 14px; border: none; border-radius: 14px; background: var(--bg-hover); color: var(--text); font-weight: 600; cursor: pointer; transition: 0.2s;">Cancel</button>
          <button id="mcpSave" style="flex: 1; padding: 14px; border: none; border-radius: 14px; background: var(--accent); color: #fff; font-weight: 600; cursor: pointer; transition: 0.2s; box-shadow: 0 4px 12px var(--accent-glow, rgba(124, 92, 252, 0.4));">Apply</button>
        </div>
      </div>
    </div>
  `;
  document.body.insertAdjacentHTML('beforeend', modalHTML);

  const modal = document.getElementById('modernColorPicker');
  const hexInput = document.getElementById('hexInput');
  const colorPreview = document.getElementById('colorPreview');
  const btnCancel = document.getElementById('mcpCancel');
  const btnSave = document.getElementById('mcpSave');
  const swatches = document.querySelectorAll('.color-swatch-preset');

  let currentTarget = null;
  let originalColor = null;
  let selectedColor = '#ffffff';

  function updatePreview(hex) {
    if (/^#[0-9A-F]{6}$/i.test(hex)) {
      colorPreview.style.backgroundColor = hex;
      selectedColor = hex;
      
      if (currentTarget) {
        currentTarget.value = hex;
        // Dispatch input to update UI live
        currentTarget.dispatchEvent(new Event('input', { bubbles: true }));
      }
    }
  }

  swatches.forEach(sw => {
    sw.addEventListener('click', () => {
      const c = sw.getAttribute('data-color');
      hexInput.value = c;
      updatePreview(c);
      
      // Add a little pop effect to the clicked swatch
      swatches.forEach(s => s.style.transform = 'scale(1)');
      sw.style.transform = 'scale(1.15)';
    });
  });

  hexInput.addEventListener('input', (e) => {
    let val = e.target.value;
    if (!val.startsWith('#')) val = '#' + val;
    if (val.length <= 7) {
      updatePreview(val);
    }
  });

  function syncBackground(el) {
    if (el.value) {
      el.style.backgroundColor = el.value;
      el.style.color = 'transparent';
      el.style.caretColor = 'transparent';
      el.style.cursor = 'pointer';
    }
  }

  colorInputs.forEach(input => {
    // Initial sync and setup observer for programmatic value changes from app.js
    syncBackground(input);
    
    // Override the value setter to automatically sync background
    const originalDescriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
    Object.defineProperty(input, 'value', {
      get: function() { return originalDescriptor.get.call(this); },
      set: function(val) {
        originalDescriptor.set.call(this, val);
        syncBackground(this);
      }
    });

    input.addEventListener('click', (e) => {
      // Very important to prevent Android's ugly native picker
      e.preventDefault(); 
      e.stopPropagation();

      currentTarget = input;
      originalColor = input.value || '#ffffff';
      selectedColor = originalColor;
      
      hexInput.value = originalColor;
      colorPreview.style.backgroundColor = originalColor;
      
      swatches.forEach(s => s.style.transform = 'scale(1)');
      
      modal.classList.add('show');
      if (window.Nav) window.Nav.push('modernColorPicker', () => modal.classList.remove('show'));
    });
  });

  btnCancel.addEventListener('click', () => {
    if (currentTarget && originalColor) {
      currentTarget.value = originalColor;
      currentTarget.dispatchEvent(new Event('input', { bubbles: true }));
    }
    closeModal();
  });

  btnSave.addEventListener('click', () => {
    if (currentTarget) {
      currentTarget.dispatchEvent(new Event('change', { bubbles: true }));
    }
    closeModal();
  });

  function closeModal() {
    modal.classList.remove('show');
    if (window.Nav && window.Nav.has('modernColorPicker')) {
      window.Nav.back();
    }
  }
});
