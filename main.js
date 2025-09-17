(() => {
  const canvas = document.getElementById('world-canvas');
  const ctx = canvas.getContext('2d');

  // World background image
  const worldImage = new Image();
  worldImage.src = 'world.jpg';

  // App state
  const state = {
    socket: null,
    connected: false,
    dirty: true,
    canvasWidth: 0,
    canvasHeight: 0,
    worldReady: false,
    me: {
      id: null,
      username: 'Sean',
      x: 0,
      y: 0,
      avatarName: null,
      facing: 'south',
      animationFrame: 0
    },
    // avatarAssets: { [avatarName]: { north: Image[], south: Image[], east: Image[], west: Image[] } }
    avatarAssets: {},
    players: {},
    camera: { x: 0, y: 0 },
    heldKeys: new Set()
  };

  // Device pixel ratio aware resizing
  function resizeCanvasToWindow() {
    const dpr = window.devicePixelRatio || 1;
    const cssWidth = window.innerWidth;
    const cssHeight = window.innerHeight;

    state.canvasWidth = cssWidth;
    state.canvasHeight = cssHeight;

    canvas.style.width = cssWidth + 'px';
    canvas.style.height = cssHeight + 'px';
    canvas.width = Math.floor(cssWidth * dpr);
    canvas.height = Math.floor(cssHeight * dpr);

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    state.dirty = true;
  }

  function clampCamera() {
    if (!state.worldReady) return;
    const worldWidth = worldImage.naturalWidth || worldImage.width || 0;
    const worldHeight = worldImage.naturalHeight || worldImage.height || 0;

    // Desired camera so my avatar is centered
    let camX = state.me.x - state.canvasWidth / 2;
    let camY = state.me.y - state.canvasHeight / 2;

    // Clamp to world bounds so we don't show past edges
    const maxCamX = Math.max(0, worldWidth - state.canvasWidth);
    const maxCamY = Math.max(0, worldHeight - state.canvasHeight);
    camX = Math.min(Math.max(camX, 0), maxCamX);
    camY = Math.min(Math.max(camY, 0), maxCamY);

    // If world smaller than canvas in a dimension, pin to 0
    if (worldWidth <= state.canvasWidth) camX = 0;
    if (worldHeight <= state.canvasHeight) camY = 0;

    state.camera.x = camX;
    state.camera.y = camY;
  }

  function ensureAvatarAssets(avatarName, framesByDir) {
    if (!avatarName || !framesByDir) return;
    if (state.avatarAssets[avatarName]) return;
    const makeImages = (urls) => (urls || []).map((src) => {
      const img = new Image();
      img.src = src;
      img.onload = () => { state.dirty = true; };
      img.onerror = () => { /* ignore */ };
      return img;
    });
    const east = makeImages(framesByDir.east);
    // West uses flipped east frames; we will flip on draw for efficiency
    state.avatarAssets[avatarName] = {
      north: makeImages(framesByDir.north),
      south: makeImages(framesByDir.south),
      east,
      west: east
    };
  }

  function getAvatarFrameImage(avatarName, facing, frameIndex) {
    const set = state.avatarAssets[avatarName];
    if (!set) return null;
    const dir = set[facing] || set.south || set.east;
    if (!dir || dir.length === 0) return null;
    const idx = Math.min(Math.max(frameIndex || 0, 0), dir.length - 1);
    return dir[idx] || null;
  }

  // Draw loop - only runs when dirty
  let rafPending = false;
  function requestDraw() {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => {
      rafPending = false;
      if (!state.dirty) return;
      state.dirty = false;
      draw();
    });
  }

  function draw() {
    // Clear the canvas in CSS pixels
    ctx.clearRect(0, 0, state.canvasWidth, state.canvasHeight);

    if (!state.worldReady) return;

    // Update camera for current state
    clampCamera();

    const camX = state.camera.x;
    const camY = state.camera.y;

    // Draw world anchored at top-left with camera offset
    ctx.drawImage(worldImage, -camX, -camY);

    // Draw all players (including me), sorted by y for natural overlap
    const players = Object.values(state.players || {});
    players.sort((a, b) => (a.y || 0) - (b.y || 0));

    for (const p of players) {
      const avatarName = p.avatar || (p.id === state.me.id ? state.me.avatarName : null);
      const facing = p.facing || 'south';
      const frameImg = getAvatarFrameImage(avatarName, facing, typeof p.animationFrame === 'number' ? p.animationFrame : 0);
      const sx = (p.x || 0) - camX;
      const sy = (p.y || 0) - camY;

      if (frameImg && frameImg.complete && frameImg.naturalWidth > 0) {
        const w = frameImg.naturalWidth;
        const h = frameImg.naturalHeight;
        if (facing === 'west') {
          ctx.save();
          ctx.translate(sx, 0);
          ctx.scale(-1, 1);
          ctx.drawImage(frameImg, -w / 2, sy - h, w, h);
          ctx.restore();
        } else {
          ctx.drawImage(frameImg, sx - w / 2, sy - h, w, h);
        }
      } else {
        // Placeholder
        const r = 16;
        ctx.fillStyle = '#4da3ff';
        ctx.beginPath();
        ctx.arc(sx, sy - r, r, 0, Math.PI * 2);
        ctx.fill();
      }

      // Username label
      const label = (p.username != null ? p.username : (p.id === state.me.id ? state.me.username : 'Player'));
      ctx.font = '14px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      const textX = sx;
      const textY = sy - (20 + 4);
      ctx.fillStyle = 'rgba(0,0,0,0.6)';
      ctx.fillRect(textX - ctx.measureText(label).width / 2 - 6, textY - 16, ctx.measureText(label).width + 12, 18);
      ctx.fillStyle = '#ffffff';
      ctx.fillText(label, textX, textY);
    }
  }

  function handleResize() {
    resizeCanvasToWindow();
    state.dirty = true;
    requestDraw();
  }

  // Movement helpers
  const keyToDirection = {
    ArrowUp: 'up',
    ArrowDown: 'down',
    ArrowLeft: 'left',
    ArrowRight: 'right'
  };

  function sendMove(direction) {
    if (!state.connected || !state.socket || state.socket.readyState !== WebSocket.OPEN) return;
    const msg = { action: 'move', direction };
    state.socket.send(JSON.stringify(msg));
  }

  function sendStop() {
    if (!state.connected || !state.socket || state.socket.readyState !== WebSocket.OPEN) return;
    state.socket.send(JSON.stringify({ action: 'stop' }));
  }

  function onKeyDown(e) {
    const dir = keyToDirection[e.key];
    if (!dir) return;
    e.preventDefault();
    // Track held keys; allow browser key repeat to trigger multiple keydown events
    state.heldKeys.add(e.key);
    // Update facing immediately for feedback
    if (dir === 'left') state.me.facing = 'west';
    else if (dir === 'right') state.me.facing = 'east';
    else if (dir === 'up') state.me.facing = 'north';
    else if (dir === 'down') state.me.facing = 'south';
    state.dirty = true;
    requestDraw();
    sendMove(dir);
  }

  function onKeyUp(e) {
    const dir = keyToDirection[e.key];
    if (!dir) return;
    e.preventDefault();
    state.heldKeys.delete(e.key);
    if (state.heldKeys.size === 0) {
      sendStop();
    }
  }

  function onBlur() {
    if (state.heldKeys.size > 0) {
      state.heldKeys.clear();
      sendStop();
    }
  }

  // Socket connection and protocol
  function connect() {
    const url = 'wss://codepath-mmorg.onrender.com';
    try {
      state.socket = new WebSocket(url);
    } catch (e) {
      console.error('WebSocket init failed', e);
      return;
    }

    state.socket.addEventListener('open', () => {
      state.connected = true;
      // Send join message as "Sean"
      const joinMsg = {
        action: 'join_game',
        username: state.me.username
      };
      state.socket.send(JSON.stringify(joinMsg));
    });

    state.socket.addEventListener('message', (event) => {
      let data;
      try {
        data = JSON.parse(event.data);
      } catch (e) {
        console.warn('Non-JSON message', event.data);
        return;
      }

      if (data && data.action === 'join_game' && data.success) {
        // Initialize players and avatars
        const players = data.players || {};
        const avatars = data.avatars || {};

        // Cache avatar assets
        Object.keys(avatars).forEach((name) => {
          const def = avatars[name];
          ensureAvatarAssets(def.name || name, def.frames || {});
        });

        state.players = players;
        state.me.id = data.playerId || null;
        const me = players[state.me.id];
        if (me) {
          state.me.x = me.x || 0;
          state.me.y = me.y || 0;
          state.me.avatarName = me.avatar || null;
          state.me.facing = me.facing || 'south';
          state.me.animationFrame = me.animationFrame || 0;
        }

        state.dirty = true;
        requestDraw();
      } else if (data && data.action === 'players_moved' && data.players) {
        // Merge updated positions/facing/animation
        const moved = data.players || {};
        Object.keys(moved).forEach((pid) => {
          const p = moved[pid];
          state.players[pid] = { ...(state.players[pid] || {}), ...p };
          if (pid === state.me.id) {
            state.me.x = p.x ?? state.me.x;
            state.me.y = p.y ?? state.me.y;
            state.me.facing = p.facing || state.me.facing;
            state.me.animationFrame = typeof p.animationFrame === 'number' ? p.animationFrame : state.me.animationFrame;
          }
        });
        state.dirty = true;
        requestDraw();
      } else if (data && data.action === 'player_joined' && data.player) {
        // Cache new player's avatar and add to state
        const p = data.player;
        if (data.avatar) {
          ensureAvatarAssets(data.avatar.name, data.avatar.frames);
        }
        state.players[p.id] = p;
        state.dirty = true;
        requestDraw();
      } else if (data && data.action === 'player_left' && data.playerId) {
        delete state.players[data.playerId];
        state.dirty = true;
        requestDraw();
      } else if (data && data.success === false) {
        console.error('Server error:', data.error || 'unknown');
      }
    });

    state.socket.addEventListener('close', () => {
      state.connected = false;
    });

    state.socket.addEventListener('error', () => {
      // Errors will likely be followed by close
    });
  }

  worldImage.onload = () => {
    state.worldReady = true;
    handleResize();
    state.dirty = true;
    requestDraw();
  };

  worldImage.onerror = () => {
    console.error('Failed to load world.jpg');
  };

  window.addEventListener('resize', handleResize);
  window.addEventListener('keydown', onKeyDown, { passive: false });
  window.addEventListener('keyup', onKeyUp, { passive: false });
  window.addEventListener('blur', onBlur);

  // Initialize
  handleResize();
  connect();
})();


