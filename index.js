const express = require('express');
const cors = require('cors');
const fs = require('fs');
const { exec } = require('child_process');
const path = require('path');
const netstat = require('node-netstat');
const WebSocket = require('ws');

const app = express();
const PORT = 3000;
const WHITELIST_PATH = path.join(__dirname, 'whitelist.json');
const wss = new WebSocket.Server({ port: 8081 });

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Helper: Load whitelist
function loadWhitelist() {
  if (!fs.existsSync(WHITELIST_PATH)) return [];
  return JSON.parse(fs.readFileSync(WHITELIST_PATH, 'utf8'));
}

// Helper: Save whitelist
function saveWhitelist(list) {
  fs.writeFileSync(WHITELIST_PATH, JSON.stringify(list, null, 2));
}

// WebSocket connection handling
wss.on('connection', (ws) => {
  console.log('Client connected');
  ws.on('close', () => console.log('Client disconnected'));
});

// Function to broadcast updates to all connected clients
function broadcastUpdate(data) {
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(data));
    }
  });
}

// Function to scan network and get devices
function scanNetwork() {
  return new Promise((resolve, reject) => {
    const devices = [];
    console.log('Starting network scan...');
    
    exec('arp -a', (err, stdout, stderr) => {
      if (err) {
        console.error('Scan error:', err);
        reject(err);
        return;
      }
      
      console.log('ARP output:', stdout);
      const lines = stdout.split('\n');
      const seenMacs = new Set(); // To prevent duplicate devices
      const devicePromises = [];
      
      for (const line of lines) {
        const match = line.match(/(\d+\.\d+\.\d+\.\d+)\s+([\da-fA-F:-]{17})/);
        if (match) {
          const ip = match[1];
          const mac = match[2].replace(/-/g, ':').toLowerCase();
          
          // Skip if we've already seen this MAC address
          if (seenMacs.has(mac)) continue;
          seenMacs.add(mac);
          
          // Filter out broadcast, multicast, and special addresses
          if (!ip.startsWith('224.') && 
              !ip.startsWith('239.') && 
              !ip.endsWith('.255') && 
              mac !== 'ff:ff:ff:ff:ff:ff' &&
              !mac.startsWith('01:00:5e') &&
              !mac.startsWith('33:33') && // IPv6 multicast
              !mac.startsWith('ff:ff')) { // Broadcast
            
            // Check if it's a hotspot device (you can add more hotspot MAC prefixes)
            const isHotspot = mac.startsWith('02:00:00') || 
                            mac.startsWith('02:1a:11') ||
                            mac.startsWith('02:50:f1');
            
            // Resolve hostname only
            const devicePromise = new Promise((resolveDevice) => {
              exec(`nslookup ${ip}`, (err, nsout, nserr) => {
                let name = 'Unknown';
                if (!err && nsout) {
                  const hostMatch = nsout.match(/Name:\s*([\w\-\.]+)/);
                  if (hostMatch && hostMatch[1]) {
                    name = hostMatch[1];
                  }
                }
                const device = { 
                  ip, 
                  mac,
                  name,
                  type: isHotspot ? 'hotspot' : 'regular',
                  lastSeen: new Date().toISOString()
                };
                resolveDevice(device);
              });
            });
            devicePromises.push(devicePromise);
          }
        }
      }
      
      Promise.all(devicePromises).then(devicesWithNames => {
        console.log('Scan complete. Found devices:', devicesWithNames);
        resolve(devicesWithNames);
      });
    });
  });
}

// Scan network endpoint
app.get('/api/scan', async (req, res) => {
  console.log('Received scan request');
  try {
    const devices = await scanNetwork();
    const whitelist = loadWhitelist();
    const result = devices.map(dev => ({
      ...dev,
      whitelisted: whitelist.includes(dev.mac)
    }));
    console.log('Sending scan results:', result);
    res.setHeader('Content-Type', 'application/json');
    res.json(result);
    broadcastUpdate({ type: 'devices', data: result });
  } catch (error) {
    console.error('Scan error:', error);
    res.setHeader('Content-Type', 'application/json');
    res.status(500).json({ 
      success: false, 
      error: 'Failed to scan network' 
    });
  }
});

// Get whitelist
app.get('/api/whitelist', (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.json(loadWhitelist());
});

// Add MAC to whitelist
app.post('/api/whitelist', (req, res) => {
  const { mac } = req.body;
  if (!mac) {
    res.setHeader('Content-Type', 'application/json');
    return res.status(400).json({ 
      success: false, 
      error: 'MAC address required' 
    });
  }
  const whitelist = loadWhitelist();
  if (!whitelist.includes(mac)) {
    whitelist.push(mac);
    saveWhitelist(whitelist);
    broadcastUpdate({ type: 'whitelist', data: whitelist });
  }
  res.setHeader('Content-Type', 'application/json');
  res.json({ success: true, whitelist });
});

// Remove MAC from whitelist
app.delete('/api/whitelist/:mac', (req, res) => {
  const mac = req.params.mac;
  if (!mac) {
    res.setHeader('Content-Type', 'application/json');
    return res.status(400).json({ 
      success: false, 
      error: 'MAC address required' 
    });
  }
  const whitelist = loadWhitelist();
  const index = whitelist.indexOf(mac);
  if (index > -1) {
    whitelist.splice(index, 1);
    saveWhitelist(whitelist);
    broadcastUpdate({ type: 'whitelist', data: whitelist });
  }
  res.setHeader('Content-Type', 'application/json');
  res.json({ success: true, whitelist });
});

// Start periodic scanning
setInterval(async () => {
  console.log('Running periodic scan...');
  try {
    const devices = await scanNetwork();
    const whitelist = loadWhitelist();
    const result = devices.map(dev => ({
      ...dev,
      whitelisted: whitelist.includes(dev.mac)
    }));
    console.log('Broadcasting periodic scan results:', result);
    broadcastUpdate({ type: 'devices', data: result });
  } catch (error) {
    console.error('Periodic scan error:', error);
  }
}, 5000); // Scan every 5 seconds

// Check hotspot status
app.get('/api/hotspot-status', (req, res) => {
  exec('netsh wlan show hostednetwork', (err, stdout, stderr) => {
    if (err) {
      console.error('Error checking hotspot status:', err);
      return res.status(500).json({ error: 'Failed to check hotspot status' });
    }
    
    const isHotspotEnabled = stdout.includes('Status                 : Started');
    res.json({ isHotspotEnabled });
  });
});

// Turn on hotspot
app.post('/api/turn-on-hotspot', (req, res) => {
  exec('netsh wlan start hostednetwork', (err, stdout, stderr) => {
    if (err) {
      console.error('Error starting hotspot:', err);
      return res.status(500).json({ success: false, error: 'Failed to start hotspot' });
    }
    res.json({ success: true });
  });
});

// Disconnect device endpoint
app.post('/api/disconnect', (req, res) => {
  try {
    const { ip, mac } = req.body;
    if (!ip || !mac) {
      res.setHeader('Content-Type', 'application/json');
      return res.status(400).json({ 
        success: false, 
        error: 'IP and MAC address required' 
      });
    }

    // First, get the interface index
    exec('netsh interface ipv4 show interfaces', (err, stdout, stderr) => {
      if (err) {
        console.error('Error getting interfaces:', err);
        res.setHeader('Content-Type', 'application/json');
        return res.status(500).json({ 
          success: false, 
          error: 'Failed to get network interfaces' 
        });
      }

      // Find the active interface
      const lines = stdout.split('\n');
      let interfaceIndex = null;
      for (const line of lines) {
        if (line.includes('Connected') && !line.includes('Loopback')) {
          const match = line.match(/^\s*(\d+)/);
          if (match) {
            interfaceIndex = match[1];
            break;
          }
        }
      }

      if (!interfaceIndex) {
        res.setHeader('Content-Type', 'application/json');
        return res.status(500).json({ 
          success: false, 
          error: 'No active network interface found' 
        });
      }

      // Disconnect the device using multiple methods
      const commands = [
        // Method 1: Remove ARP entry
        `arp -d ${ip}`,
        // Method 2: Block the MAC address
        `netsh advfirewall firewall add rule name="Block ${mac}" dir=in action=block remoteip=${ip}`,
        // Method 3: Disconnect using netsh
        `netsh interface ipv4 set interface "${interfaceIndex}" admin=disable`,
        `netsh interface ipv4 set interface "${interfaceIndex}" admin=enable`
      ];

      // Execute commands in sequence
      let currentCommand = 0;
      function executeNextCommand() {
        if (currentCommand >= commands.length) {
          // All commands executed, remove from whitelist if needed
          const whitelist = loadWhitelist();
          const index = whitelist.indexOf(mac);
          if (index > -1) {
            whitelist.splice(index, 1);
            saveWhitelist(whitelist);
          }
          res.setHeader('Content-Type', 'application/json');
          return res.json({ 
            success: true, 
            message: 'Device disconnected successfully' 
          });
        }

        exec(commands[currentCommand], (err, stdout, stderr) => {
          if (err) {
            console.error(`Error executing command ${currentCommand}:`, err);
          }
          currentCommand++;
          executeNextCommand();
        });
      }

      executeNextCommand();
    });
  } catch (error) {
    console.error('Error in disconnect endpoint:', error);
    res.setHeader('Content-Type', 'application/json');
    res.status(500).json({ 
      success: false, 
      error: 'Internal server error' 
    });
  }
});

app.listen(PORT, () => {
  console.log(`Secure WiFi Manager backend running on http://localhost:${PORT}`);
}); 