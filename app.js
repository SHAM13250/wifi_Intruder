// High-quality, interactive, real-time WiFi Intruder Alert Frontend
const API_BASE = 'http://localhost:3000/api';

const tableBody = document.querySelector('#devicesTable tbody');
const scanBtn = document.getElementById('scanBtn');
const dangerSound = document.getElementById('dangerSound');

let lastKnownDevices = new Set();
let newDevice = null;

// WebSocket for real-time updates
const ws = new WebSocket('ws://localhost:8081');

ws.onopen = function() {
  fetchDevices();
};

ws.onclose = function() {
  setTimeout(() => window.location.reload(), 5000);
};

ws.onmessage = function(event) {
  const msg = JSON.parse(event.data);
  if (msg.type === 'devices') {
    updateDeviceTable(msg.data);
  }
};

function fetchDevices() {
  fetch(`${API_BASE}/scan`)
    .then(res => res.json())
    .then(updateDeviceTable);
}

// Restore table header to only include Device Name (remove Manufacturer)
const table = document.getElementById('devicesTable');
const thead = table.querySelector('thead tr');
if (thead && thead.children.length > 6) {
  // Remove Manufacturer column if present
  thead.removeChild(thead.children[2]);
}

function updateDeviceTable(devices) {
  const currentDevices = new Set(devices.map(d => d.mac));
  // Check for new devices
  devices.forEach(device => {
    if (!lastKnownDevices.has(device.mac) && !device.whitelisted) {
      showWarningModal(device);
    }
  });

  tableBody.innerHTML = '';
  if (devices.length === 0) {
    const tr = document.createElement('tr');
    tr.innerHTML = '<td colspan="6" style="text-align: center;">No devices found</td>';
    tableBody.appendChild(tr);
  } else {
    devices.forEach(device => {
      const tr = document.createElement('tr');
      tr.className = device.whitelisted ? 'whitelisted' : 'unknown';
      tr.innerHTML = `
        <td>${device.ip}</td>
        <td>${device.name || 'Unknown'}</td>
        <td>${device.mac}</td>
        <td>${device.whitelisted ? 'Whitelisted' : 'Unknown'}</td>
        <td>${new Date(device.lastSeen).toLocaleTimeString()}</td>
        <td>
          ${device.whitelisted ? 
            `<button class="remove" data-mac="${device.mac}">Remove</button>` : 
            `<button class="whitelist" data-mac="${device.mac}">Whitelist</button>`
          }
          <button class="disconnect" data-ip="${device.ip}" data-mac="${device.mac}">Disconnect</button>
        </td>
      `;
      tableBody.appendChild(tr);
    });
  }
  lastKnownDevices = currentDevices;
}

// Scan button event
scanBtn.addEventListener('click', function() {
  scanBtn.disabled = true;
  scanBtn.textContent = 'Scanning...';
  fetchDevices();
  setTimeout(() => {
    scanBtn.disabled = false;
    scanBtn.textContent = 'Rescan Network';
  }, 2000);
});

// Modal logic
function showWarningModal(device) {
  // Create modal if not exists
  let modal = document.getElementById('warningModal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'warningModal';
    modal.className = 'modal';
    modal.innerHTML = `
      <div class="modal-content warning">
        <span id="closeWarningModal" class="close">&times;</span>
        <h2>⚠️ New Device Detected</h2>
        <p id="warningDeviceInfo"></p>
        <p class="warning-message">A new device is trying to connect to your network. Please review and take action.</p>
        <button id="acceptDevice">Accept (Whitelist)</button>
        <button id="denyDevice">Deny</button>
      </div>
    `;
    document.body.appendChild(modal);
  }
  const warningDeviceInfo = document.getElementById('warningDeviceInfo');
  warningDeviceInfo.innerHTML = `
    <div style="margin: 15px 0;">
      <p><strong>IP Address:</strong> ${device.ip}</p>
      <p><strong>MAC Address:</strong> ${device.mac}</p>
      <p><strong>Time Detected:</strong> ${new Date(device.lastSeen).toLocaleTimeString()}</p>
    </div>
  `;
  modal.style.display = 'block';
  dangerSound.play();
  // Notification
  if (Notification.permission !== 'granted') {
    Notification.requestPermission();
  }
  if (Notification.permission === 'granted') {
    new Notification('⚠️ New Device Detected', {
      body: `A new device (${device.ip}) has connected to your network.`
    });
  }
  // Button handlers
  document.getElementById('closeWarningModal').onclick = function() {
    modal.style.display = 'none';
  };
  document.getElementById('acceptDevice').onclick = function() {
    fetch(`${API_BASE}/whitelist`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mac: device.mac })
    }).then(() => {
      modal.style.display = 'none';
      fetchDevices();
    });
  };
  document.getElementById('denyDevice').onclick = function() {
    modal.style.display = 'none';
  };
}

// Table actions
// Delegate for whitelist/remove/disconnect
// (Re-attach after every table update)
tableBody.addEventListener('click', function(e) {
  if (e.target.classList.contains('whitelist')) {
    const mac = e.target.getAttribute('data-mac');
    fetch(`${API_BASE}/whitelist`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mac })
    }).then(fetchDevices);
  } else if (e.target.classList.contains('remove')) {
    const mac = e.target.getAttribute('data-mac');
    fetch(`${API_BASE}/whitelist/${mac}`, { method: 'DELETE' })
      .then(fetchDevices);
  } else if (e.target.classList.contains('disconnect')) {
    const ip = e.target.getAttribute('data-ip');
    const mac = e.target.getAttribute('data-mac');
    showDisconnectModal({ ip, mac });
  }
});

// Disconnect modal
function showDisconnectModal(device) {
  let modal = document.getElementById('disconnectModal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'disconnectModal';
    modal.className = 'modal';
    modal.innerHTML = `
      <div class="modal-content warning">
        <span id="closeDisconnectModal" class="close">&times;</span>
        <h2>⚠️ Disconnect Device</h2>
        <p id="disconnectDeviceInfo"></p>
        <p class="warning-message">Are you sure you want to disconnect this device?</p>
        <div class="modal-actions">
          <button id="confirmDisconnect">Yes, Disconnect</button>
          <button id="cancelDisconnect">Cancel</button>
        </div>
      </div>
    `;
    document.body.appendChild(modal);
  }
  const disconnectDeviceInfo = document.getElementById('disconnectDeviceInfo');
  disconnectDeviceInfo.innerHTML = `
    <div style="margin: 15px 0;">
      <p><strong>IP Address:</strong> ${device.ip}</p>
      <p><strong>MAC Address:</strong> ${device.mac}</p>
    </div>
  `;
  modal.style.display = 'block';

  const confirmBtn = document.getElementById('confirmDisconnect');
  const cancelBtn = document.getElementById('cancelDisconnect');
  const closeBtn = document.getElementById('closeDisconnectModal');

  // Remove previous event listeners
  confirmBtn.onclick = null;
  cancelBtn.onclick = null;
  closeBtn.onclick = null;

  closeBtn.onclick = function() {
    modal.style.display = 'none';
  };
  cancelBtn.onclick = function() {
    modal.style.display = 'none';
  };
  confirmBtn.onclick = function() {
    confirmBtn.disabled = true;
    confirmBtn.textContent = 'Disconnecting...';
    fetch(`${API_BASE}/disconnect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(device)
    })
    .then(res => res.json())
    .then(data => {
      modal.style.display = 'none';
      confirmBtn.disabled = false;
      confirmBtn.textContent = 'Yes, Disconnect';
      // Show a success message
      const msg = document.createElement('div');
      msg.className = data.success ? 'success-message' : 'error-message';
      msg.textContent = data.message || (data.success ? 'Device disconnected.' : 'Failed to disconnect device.');
      document.body.appendChild(msg);
      setTimeout(() => msg.remove(), 3000);
      fetchDevices();
    })
    .catch(() => {
      confirmBtn.disabled = false;
      confirmBtn.textContent = 'Yes, Disconnect';
      // Show an error message
      const msg = document.createElement('div');
      msg.className = 'error-message';
      msg.textContent = 'Failed to disconnect device. Please try again.';
      document.body.appendChild(msg);
      setTimeout(() => msg.remove(), 3000);
    });
  };
}

// Initial load
fetchDevices();
// Request notification permission on load
if (window.Notification && Notification.permission !== 'granted') {
  Notification.requestPermission();
} 