/** GLOBAL STATE (4-PLAYER ARCHITECTURE) **/
let state = {
	players: [], // e.g. ['player1', 'player2', 'player3', 'player4']
	names: {},
	life: {},
	mana: {}, // tracks W U B R G C
	cardBacks: {}, // tracks custom card back url per player role
	playmats: {}, // Tracks custom playmat URL per player role
	zones: {}, // deck_player1, play_player2, command_player1, etc.
	cardIdCounter: 0
};

let customLifeTotals = null;
let hasSetCustomLifeTotals = false;

/** SAVED BOARD STATE **/
let myInitialDeck = null;

/** MULTI-SELECTION, DRAG, & WIDGET STATE **/
let topXTargetRole = null;
let draggedCardIds = [];
let isSelecting = false;
let selectStartX = 0, selectStartY = 0;
let selectionBox = null;
let currentSelectionZone = null;
let activeCreateZone = null;
const selectedCardIds = new Set();
let currentSearchZoneKey = null;
let currentSearchLimit = null;
let topXActiveSession = null;
let topXModalZone = null;
let hoveringCard = null;

let currentScale = 1; 
let dragOffsetX = 0;
let dragOffsetY = 0;

/** LOCAL MEDIA CACHE **/
let pendingPlaymatUrl = '';
let pendingCardBackUrl = '';

/** UI PREFERENCES **/
let uiPrefs = {
	fontSize: 1,
	zoomScale: 2,
	handPosTop: false,
	sidePosLeft: false,
	sideZoneOrder: ['deck', 'graveyard', 'exile', 'command']
};

/** NETWORKING VARIABLES **/
const PREFIX = 'multi-html-engine-v4-';
let peer = null;
let connections = {}; // maps playerId -> connection (used by Host)
let myConnection = null; // used by Guest to speak to Host
let myRole = null;     
let isHost = false;
let reconnectInterval = null;

/** UI ELEMENTS **/
const nameInput = document.getElementById('player-name');
const codeInput = document.getElementById('game-code');
const btnHost = document.getElementById('btn-host');
const btnJoin = document.getElementById('btn-join');
const gameWrapper = document.getElementById('game-wrapper');

/** WIDGET DRAGGING LOGIC **/
const widgetZone = document.getElementById('widget-zone');
const widgetHeader = document.getElementById('widget-header');
let isDraggingWidget = false, wStartX, wStartY, wStartLeft, wStartTop;

widgetHeader.addEventListener('mousedown', (e) => {
	isDraggingWidget = true;
	wStartX = e.clientX;
	wStartY = e.clientY;
	wStartLeft = widgetZone.offsetLeft;
	wStartTop = widgetZone.offsetTop;
	document.body.style.userSelect = 'none';
});
window.addEventListener('mousemove', (e) => {
	if (!isDraggingWidget) return;
	widgetZone.style.left = (wStartLeft + (e.clientX - wStartX)) + 'px';
	widgetZone.style.top = (wStartTop + (e.clientY - wStartY)) + 'px';
});
window.addEventListener('mouseup', () => { isDraggingWidget = false; document.body.style.userSelect = ''; });

function openCustomCounterModal() {
	document.getElementById('custom-counter-input').value = '';
	document.getElementById('custom-counter-modal').style.display = 'flex';
	document.getElementById('custom-counter-input').focus();
}

function submitCustomCounter() {
	const label = document.getElementById('custom-counter-input').value.trim();
	if (!label) return;
	
	// Grab the currently selected cards, or fallback to an empty array
	let ids = Array.from(selectedCardIds); 
	if (ids.length === 0) return; 
	
	// Fire off the action to the network
	requestAction('SET_CUSTOM_COUNTER', { cardIds: ids, label: label });
	document.getElementById('custom-counter-modal').style.display = 'none';
}

function openSetLifeModal() {
	const container = document.getElementById('individual-life-container');
	container.innerHTML = '';
	state.players.forEach(p => {
		const currentLife = state.life[p] ?? 20;
		container.innerHTML += `
			<div style="display: flex; justify-content: space-between; align-items: center; background: #111; padding: 6px 10px; border-radius: 4px;">
				<span>${state.names[p] || p}</span>
				<input type="number" id="life-input-${p}" value="${currentLife}" style="width: 80px; padding: 4px;">
			</div>
		`;
	});
	document.getElementById('set-life-modal').style.display = 'flex';
}

function applyAllLifeInput() {
	const val = parseInt(document.getElementById('life-all-input').value) || 20;
	state.players.forEach(p => {
		const input = document.getElementById(`life-input-${p}`);
		if (input) input.value = val;
	});
}

function saveLifeTotalsModal() {
	const totals = {};
	state.players.forEach(p => {
		const input = document.getElementById(`life-input-${p}`);
		if (input) {
			totals[p] = parseInt(input.value) || 20;
		}
	});
	requestAction('SET_LIFE_TOTALS', { totals });
	document.getElementById('set-life-modal').style.display = 'none';
}

/** WIDGET TOGGLES & PREFS **/
function toggleLogView() { document.getElementById('log').style.display = document.getElementById('toggle-log').checked ? 'block' : 'none'; }
function adjustUIText(amt) { uiPrefs.fontSize = Math.max(0.7, uiPrefs.fontSize + amt); applyUIPrefs(); }
function adjustZoom(amt) { uiPrefs.zoomScale = Math.max(1, uiPrefs.zoomScale + amt); applyUIPrefs(); }
function toggleHandPos() { uiPrefs.handPosTop = document.getElementById('toggle-hand-pos').checked; applyUIPrefs(); }
function toggleSidePos() { uiPrefs.sidePosLeft = document.getElementById('toggle-side-pos').checked; applyUIPrefs(); }
function moveZonePref(idx, dir) {
	const arr = uiPrefs.sideZoneOrder;
	if (idx + dir < 0 || idx + dir >= arr.length) return;
	let temp = arr[idx]; arr[idx] = arr[idx + dir]; arr[idx + dir] = temp;
	applyUIPrefs();
}

function applyUIPrefs() {
	document.documentElement.style.setProperty('--ui-font-size', uiPrefs.fontSize + 'rem');
	document.documentElement.style.setProperty('--hover-scale', uiPrefs.zoomScale);
	document.documentElement.style.setProperty('--ui-scale', uiPrefs.fontSize); // Sync dice UI scale
	document.getElementById('my-center-zones').style.flexDirection = uiPrefs.handPosTop ? 'column-reverse' : 'column';
	document.getElementById('my-row').style.flexDirection = uiPrefs.sidePosLeft ? 'row-reverse' : 'row';
	
	uiPrefs.sideZoneOrder.forEach((zone, idx) => {
		document.getElementById(`my-${zone}-zone`).style.order = idx;
	});
	
	const reorderContainer = document.getElementById('reorder-controls');
	reorderContainer.innerHTML = '';
	uiPrefs.sideZoneOrder.forEach((zone, idx) => {
		const zName = zone.charAt(0).toUpperCase() + zone.slice(1);
		reorderContainer.innerHTML += `
			<div style="display: flex; justify-content: space-between; background: #222; padding: 2px 6px; border-radius: 4px;">
				<span>${zName}</span>
				<div>
					<button onclick="moveZonePref(${idx}, -1)" ${idx === 0 ? 'disabled' : ''} style="background:#444; color:white; border:none; border-radius:2px; cursor:pointer;">▲</button>
					<button onclick="moveZonePref(${idx}, 1)" ${idx === uiPrefs.sideZoneOrder.length-1 ? 'disabled' : ''} style="background:#444; color:white; border:none; border-radius:2px; cursor:pointer;">▼</button>
				</div>
			</div>`;
	});
}
applyUIPrefs();

/** RESIZE HANDLER **/
function resizeUI() {
	if (gameWrapper.style.display === 'none') return;
	const winW = window.innerWidth;
	const winH = window.innerHeight;
	currentScale = Math.min(winW / 2560, winH / 1440);
	gameWrapper.style.transform = `scale(${currentScale})`;
	gameWrapper.style.left = `${(winW - (2560 * currentScale)) / 2}px`;
	gameWrapper.style.top = `${(winH - (1440 * currentScale)) / 2}px`;
}
window.addEventListener('resize', resizeUI);

/** KEYBOARD SHORTCUTS **/
window.addEventListener('keydown', (e) => {
	// Ignore shortcuts if the user is typing in an input, textarea, or contenteditable element
	if (['INPUT', 'TEXTAREA'].includes(e.target.tagName) || e.target.isContentEditable) {
		return;
	}

	// Ensure the game is active/visible
	if (gameWrapper.style.display === 'none') return;

	const key = e.key.toUpperCase();

	switch (key) {
		case 'U':
			// U = Untap functionality (triggers Untap All for your board)
			requestAction('UNTAP_ALL', {});
			break;
		case 'S':
			// S = Shuffle the deck
			requestAction('SHUFFLE_DECK', {});
			break;
		case 'D':
			// D = Draw a card from your deck
			requestAction('DRAW_CARDS', { amount: 1 });
			break;
	}
});

/** LOGIN LOGIC **/
codeInput.addEventListener('input', (e) => {
	const valid = e.target.value.trim().length >= 6;
	document.getElementById('error-msg').style.visibility = valid ? 'hidden' : 'visible';
	btnHost.disabled = btnJoin.disabled = !valid;
});

function showError(msg) {
	document.getElementById('error-details').innerText = msg;
	document.querySelector('.error-content').style.background = '#8b0000';
	document.getElementById('error-modal').style.display = 'flex';
	document.getElementById('loading-msg').style.display = 'none';
}

/** PEERJS 4-PLAYER NETWORKING **/
function initPlayer(role, name) {
	if(!state.players.includes(role)) state.players.push(role);
	state.names[role] = name;
	state.life[role] = 20;
	if(!state.mana) state.mana = {};
	state.mana[role] = { W:0, U:0, B:0, R:0, G:0, C:0 };
	if(!state.cardBacks) state.cardBacks = {};
	if(!state.cardBacks[role]) state.cardBacks[role] = '';
	if(!state.playmats) state.playmats = {};
	if(!state.playmats[role]) state.playmats[role] = '';
	['deck','play','hand','graveyard','exile','command'].forEach(z => {
		if(!state.zones[z+'_'+role]) state.zones[z+'_'+role] = [];
	});
}

btnHost.addEventListener('click', () => {
	const code = codeInput.value.trim().toLowerCase();
	const myName = nameInput.value.trim() || 'Host';
	document.getElementById('loading-msg').style.display = 'block';
	
	peer = new Peer(PREFIX + code);
	peer.on('open', () => {
		isHost = true;
		myRole = 'player1';
		initPlayer(myRole, myName);
		startGameUI();
		logToUI(`Hosting game. Waiting for up to 3 players to join...`);
	});

	peer.on('connection', (conn) => {
		conn.on('data', (data) => {
			if (data.type === 'INIT') {
				let role = Object.keys(state.names).find(k => state.names[k] === data.name);
				if (!role) {
					if (state.players.length >= 4) { conn.send({type: 'ERROR', msg: 'Game is full.'}); return; }
					role = 'player' + (Object.keys(state.names).length + 1);
					initPlayer(role, data.name);
					broadcastLog(`<b>${data.name}</b> has joined the game.`);
				} else {
					if (!state.players.includes(role)) state.players.push(role);
					broadcastLog(`<b>${data.name}</b> has reconnected.`);
				}
				connections[role] = conn;
				setupHostConnection(conn, role);
				conn.send({ type: 'ASSIGN_ROLE', role: role, state: state });
				broadcastState();
			}
		});
	});
	peer.on('error', (err) => showError("Host Error: " + err.message));
});

btnJoin.addEventListener('click', () => {
	const code = codeInput.value.trim().toLowerCase();
	const myName = nameInput.value.trim() || 'Guest';
	document.getElementById('loading-msg').style.display = 'block';
	
	peer = new Peer(); 
	peer.on('open', () => {
		isHost = false;
		myConnection = peer.connect(PREFIX + code, { reliable: true });
		myConnection.on('open', () => {
			myConnection.send({ type: 'INIT', name: myName });
		});
		myConnection.on('data', (data) => {
			if (data.type === 'ERROR') { showError(data.msg); myConnection.close(); }
			else if (data.type === 'ASSIGN_ROLE') {
				myRole = data.role;
				state = data.state;
				setupGuestConnection(myConnection);
				startGameUI();
				logToUI("Successfully joined!");
			}
			else if (data.type === 'STATE_SYNC') { state = data.state; renderAll(); }
			else if (data.type === 'ACTION') { processAction(data.action); }
			else if (data.type === 'LOG') logToUI(data.msg);
		});
		myConnection.on('close', handleDisconnect);
		myConnection.on('error', handleDisconnect);
	});
	peer.on('error', (err) => showError("Peer Error: " + err.message));
});

function setupHostConnection(conn, role) {
	conn.on('data', (data) => {
		if (data.type === 'ACTION') {
			processAction(data.action);
			// Host relays the action to all OTHER guests
			Object.entries(connections).forEach(([otherRole, otherConn]) => {
				if (otherRole !== role && otherConn && otherConn.open) {
					otherConn.send({ type: 'ACTION', action: data.action });
				}
			});
		}
	});
	conn.on('close', () => {
		broadcastLog(`<b>${state.names[role]}</b> disconnected.`);
		state.players = state.players.filter(p => p !== role);
		delete connections[role];
		broadcastState();
	});
	conn.on('error', () => {
		broadcastLog(`<b>${state.names[role]}</b> lost connection.`);
		state.players = state.players.filter(p => p !== role);
		delete connections[role];
		broadcastState();
	});
}

function setupGuestConnection(conn) {
	conn.on('close', handleDisconnect);
	conn.on('error', handleDisconnect);
}

function handleDisconnect() {
	if (reconnectInterval || isHost) return; 
	showError("Connection lost. Attempting to gracefully reconnect...");
	document.querySelector('.error-content').style.background = '#8b6b00'; 
	
	reconnectInterval = setInterval(() => {
		let newConn = peer.connect(PREFIX + codeInput.value.trim().toLowerCase(), { reliable: true });
		newConn.on('open', () => {
			clearInterval(reconnectInterval); reconnectInterval = null;
			myConnection = newConn;
			newConn.send({ type: 'INIT', name: state.names[myRole] || 'Guest' });
			document.getElementById('error-details').innerText = "Successfully Reconnected!";
			document.querySelector('.error-content').style.background = '#28a745'; 
			setTimeout(() => { document.getElementById('error-modal').style.display = 'none'; }, 2000);
		});
	}, 3000);
}

function startGameUI() {
	document.getElementById('login-screen').style.display = 'none';
	document.getElementById('widget-zone').style.display = 'flex';
	gameWrapper.style.display = 'block';
	resizeUI(); 
	buildOpponentsHTML();
	renderAll();
}

/** ACTION DISPATCHER & BROADCAST **/
function requestAction(type, payload) {
	const action = { type, player: myRole, payload };
	if (isHost) {
		processAction(action);
		// Host broadcasts the action to all guests immediately
		Object.values(connections).forEach(conn => {
			if (conn && conn.open) conn.send({ type: 'ACTION', action: action });
		});
	} else if (myConnection && myConnection.open) {
		processAction(action); // Guest updates optimistically
		myConnection.send({ type: 'ACTION', action: action }); // Guest sends to Host
	}
}

function broadcastState() {
	renderAll();
	if (!isHost) return;
	Object.values(connections).forEach(conn => { if (conn && conn.open) conn.send({ type: 'STATE_SYNC', state: state }); });
}

function broadcastLog(msg) {
	if (!isHost) return;
	logToUI(msg);
	Object.values(connections).forEach(conn => { if (conn && conn.open) conn.send({ type: 'LOG', msg: msg }); });
}

function getZoneDisplayName(zoneKey) {
	if (!zoneKey) return '';
	const [zoneType, ownerRole] = zoneKey.split('_');
	return `${state.names[ownerRole]}'s ${zoneType.charAt(0).toUpperCase() + zoneType.slice(1)}`;
}

/** GAME LOGIC PROCESSOR (Only Host / Optimistic Guest) **/
function processAction(action) {
	const { type, player, payload } = action;
	const playerName = state.names[player];

	switch (type) {
		case 'ADJUST_LIFE':
			state.life[payload.target] += payload.amount;
			broadcastLog(`${playerName} adjusted ${state.names[payload.target]}'s life by ${payload.amount > 0 ? '+'+payload.amount : payload.amount}`);
			triggerLifeAnimation(payload.target, payload.amount);
			break;
		case 'SET_LIFE_TOTALS':
			customLifeTotals = payload.totals;
			hasSetCustomLifeTotals = true;
			Object.entries(payload.totals).forEach(([p, val]) => {
				state.life[p] = val;
			});
			broadcastLog(`${playerName} set custom life totals.`);
			break;					
		case 'MODIFY_MANA':
			if (!state.mana) state.mana = {};
			if (!state.mana[payload.target]) state.mana[payload.target] = { W:0, U:0, B:0, R:0, G:0, C:0 };
			if (payload.amount === 'clear') {
				state.mana[payload.target][payload.color] = 0;
			} else {
				state.mana[payload.target][payload.color] = Math.max(0, state.mana[payload.target][payload.color] + payload.amount);
			}
			break;
		case 'SET_CARD_BACK':
			if (!state.cardBacks) state.cardBacks = {};
			state.cardBacks[player] = payload.cardBackUrl;
			broadcastLog(`${playerName} updated their card back.`);
			break;
		case 'SET_PLAYMAT':
			if (!state.playmats) state.playmats = {};
			state.playmats[player] = payload.playmatUrl;
			broadcastLog(`${playerName} updated their playmat.`);
			break;
		case 'ROLL_DICE':
			broadcastLog(`${playerName} ${payload.sides === 'Coin' ? 'flipped a coin' : 'rolled a D'+payload.sides}: <b>${payload.result}</b>`);
			break;
		case 'IMPORT_CARDS':
			// Pre-bake IDs into the payload so all clients use the exact same unique IDs
			payload.cards.forEach(c => { 
				if (!c.id) c.id = 'card_' + Math.random().toString(36).substr(2,9); 
				state.zones[payload.zone].push(c); 
			});
			if(payload.zone.startsWith('deck')) {
				if (!payload.shuffledIds) {
					shuffleInternal(payload.zone);
					payload.shuffledIds = state.zones[payload.zone].map(c => c.id);
				} else {
					const deck = state.zones[payload.zone];
					state.zones[payload.zone] = payload.shuffledIds.map(id => deck.find(c => c.id === id)).filter(Boolean);
				}
			}
			broadcastLog(`${playerName} imported ${payload.cards.length} card(s) into ${getZoneDisplayName(payload.zone)}.`);
			break;
		case 'RESET_GAME':
			Object.keys(state.zones).forEach(zName => { if (zName.endsWith('_' + player)) state.zones[zName] = []; });
	
			if (!payload.processedDeck) {
				payload.deck.forEach(c => { c.id = 'card_' + Math.random().toString(36).substr(2,9); });
				payload.processedDeck = JSON.parse(JSON.stringify(payload.deck));
			}
			let clonedDeck = JSON.parse(JSON.stringify(payload.processedDeck));
			clonedDeck.forEach(c => { c.facedown = true; c.rotated = false; delete c.x; delete c.y; state.zones[`deck_${player}`].push(c); });
			
			// Respect custom life totals if configured, otherwise default to 20
			if (hasSetCustomLifeTotals && customLifeTotals && customLifeTotals[player] !== undefined) {
				state.life[player] = customLifeTotals[player];
			} else {
				state.life[player] = 20;
			}
			
			if(state.mana && state.mana[player]) state.mana[player] = { W:0, U:0, B:0, R:0, G:0, C:0 };
	
			if (!payload.shuffledIds) {
				shuffleInternal(`deck_${player}`);
				payload.shuffledIds = state.zones[`deck_${player}`].map(c => c.id);
			} else {
				const deck = state.zones[`deck_${player}`];
				state.zones[`deck_${player}`] = payload.shuffledIds.map(id => deck.find(c => c.id === id)).filter(Boolean);
			}
			broadcastLog(`${playerName} reset their board state to a New Game.`);
			break;
		case 'SHUFFLE_DECK':
			const targetPlayer = payload.targetPlayer || player;
			const targetDeckKey = `deck_${targetPlayer}`;
			
			if (!payload.shuffledIds) {
				shuffleInternal(targetDeckKey);
				payload.shuffledIds = state.zones[targetDeckKey].map(c => c.id);
			} else {
				const deck = state.zones[targetDeckKey];
				state.zones[targetDeckKey] = payload.shuffledIds.map(id => deck.find(c => c.id === id)).filter(Boolean);
			}
			
			if (targetPlayer === player) {
				broadcastLog(`${playerName} shuffled their deck.`);
			} else {
				broadcastLog(`${playerName} shuffled ${state.names[targetPlayer]}'s deck.`);
			}
			break;
		case 'DRAW_CARDS':
			for(let i=0; i<payload.amount; i++) {
				let d = state.zones[`deck_${player}`];
				if (d.length > 0) executeMoveCard(d[d.length - 1].id, `hand_${player}`, 'top');
			}
			broadcastLog(`${playerName} drew ${payload.amount} card(s).`);
			break;
		case 'UNTAP_ALL':
			let count = 0;
			state.zones[`play_${player}`].forEach(c => { if (c.rotated) { c.rotated = false; count++; } });
			if (count > 0) broadcastLog(`${playerName} untapped ${count} card(s).`);
			break;
		case 'MOVE_CARDS':
			payload.cardIds.forEach((id, idx) => {
				const info = findCardGlobal(id);
				if (info) {
					const isFromHidden = info.zone.startsWith('hand') || info.zone.startsWith('deck') || info.zone.startsWith('graveyard') || info.zone.startsWith('exile') || info.zone.startsWith('command') || (info.card.facedown && info.zone.startsWith('play'));
					const isToHidden = payload.toZone.startsWith('hand') || payload.toZone.startsWith('deck') || payload.toZone.startsWith('graveyard') || payload.toZone.startsWith('exile') || payload.toZone.startsWith('command') || (info.card.facedown && payload.toZone.startsWith('play'));
			
					let targetX = payload.x !== undefined ? payload.x + (idx * 0.015) : undefined;
					let targetY = payload.y !== undefined ? payload.y + (idx * 0.05) : undefined;
			
					if (payload.toZone.startsWith('play') && targetX !== undefined && targetY !== undefined) {
						const existingCards = state.zones[payload.toZone].filter(c => !payload.cardIds.includes(c.id));
						for (let ec of existingCards) {
							if (ec.x !== undefined && ec.y !== undefined) {
								if (Math.abs(targetX - ec.x) < 0.06 && Math.abs(targetY - ec.y) < 0.1) {
									targetX = ec.x + 0.015; targetY = ec.y + 0.05; break;
								}
							}
						}
					}
					executeMoveCard(id, payload.toZone, payload.index, targetX, targetY);
			
					const revealName = (!isFromHidden || !isToHidden || (!info.card.facedown && payload.toZone.startsWith('play')));
					const displayStr = revealName ? `<b>${info.card.name}</b>` : "a card";
					broadcastLog(`${playerName} moved ${displayStr} from ${getZoneDisplayName(info.zone)} to ${getZoneDisplayName(payload.toZone)}.`);
				}
			});
			if (topXActiveSession) topXActiveSession = topXActiveSession.filter(c => !payload.cardIds.includes(c.id));
			break;
		case 'MOVE_CARDS_RANDOM_BOTTOM':
			if (!payload.randomizedIds) {
				let ids = [...payload.cardIds];
				for (let i = ids.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [ids[i], ids[j]] = [ids[j], ids[i]]; }
				payload.randomizedIds = ids;
			}
			payload.randomizedIds.forEach(id => executeMoveCard(id, payload.toZone, 'bottom'));
			broadcastLog(`${playerName} moved ${payload.cardIds.length} card(s) to the bottom of their deck in random order.`);
			break;
		case 'ROTATE_CARDS': payload.cardIds.forEach(id => { const i = findCardGlobal(id); if (i) i.card.rotated = !i.card.rotated; }); break;
		case 'FLIP_CARDS': 
			payload.cardIds.forEach(id => { 
				const i = findCardGlobal(id); 
				if (i) { 
					i.card.facedown = !i.card.facedown; 
					broadcastLog(`${playerName} flipped a card ${i.card.facedown ? 'face down' : 'face up'}.`);
				}
			}); break;
		case 'COPY_CARDS':
			if (!payload.newIds) {
				payload.newIds = payload.cardIds.map(() => 'card_' + Math.random().toString(36).substr(2,9));
			}
			payload.cardIds.forEach((id, index) => {
				const i = findCardGlobal(id);
				if (i) {
					let nc = JSON.parse(JSON.stringify(i.card)); 
					nc.id = payload.newIds[index];
					if (nc.x !== undefined) nc.x += 0.02; if (nc.y !== undefined) nc.y += 0.02;
					state.zones[i.zone].push(nc);
				}
			});
			broadcastLog(`${playerName} copied ${payload.cardIds.length} card(s).`); break;
		case 'MODIFY_COUNTERS':
			payload.cardIds.forEach(id => { const i = findCardGlobal(id); if(i) { if(!i.card.counters) i.card.counters={green:0,red:0}; i.card.counters[payload.cType] = Math.max(0, i.card.counters[payload.cType] + payload.amount); }}); break;
		case 'CLEAR_COUNTER_TYPE':
			payload.cardIds.forEach(id => { const i = findCardGlobal(id); if(i && i.card.counters) i.card.counters[payload.cType] = 0; }); break;
		case 'SET_CUSTOM_COUNTER':
			payload.cardIds.forEach(id => { 
				const i = findCardGlobal(id); 
				if(i) {
					i.card.customCounterLabel = payload.label; 
				}
			}); 
			break;
		case 'CLEAR_CUSTOM_COUNTER':
			payload.cardIds.forEach(id => { 
				const i = findCardGlobal(id); 
				if(i) {
					delete i.card.customCounterLabel;
				}
			}); 
			break;
		case 'DELETE_CARDS':
			payload.cardIds.forEach(id => { const i = findCardGlobal(id); if(i) state.zones[i.zone].splice(i.index, 1); });
			broadcastLog(`${playerName} deleted ${payload.cardIds.length} card(s).`); break;
	}

	// We update local UI via renderAll, avoiding full network broadcast logic
	renderAll(); 
}

function shuffleInternal(key) { const d = state.zones[key]; for (let i = d.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [d[i], d[j]] = [d[j], d[i]]; } }
function findCardGlobal(id) { for (const [z, arr] of Object.entries(state.zones)) { const idx = arr.findIndex(c => c.id === id); if (idx !== -1) return { card: arr[idx], zone: z, index: idx }; } return null; }

function executeMoveCard(cardId, toZone, index, x, y) {
	const i = findCardGlobal(cardId); if (!i) return;
	const card = state.zones[i.zone].splice(i.index, 1)[0];
	if (toZone.startsWith('deck')) card.facedown = true; 
	if (toZone.startsWith('hand')) card.facedown = false;
	if (!toZone.startsWith('play')) card.rotated = false;
	
	if (toZone.startsWith('play')) {
		 if (x !== undefined && y !== undefined) { card.x = x; card.y = y; } 
		 else if (card.x === undefined || i.zone !== toZone) { card.x = 0.5; card.y = 0.5; }
	} else { delete card.x; delete card.y; }
	
	if (index === 'top') state.zones[toZone].push(card); else if (index === 'bottom') state.zones[toZone].unshift(card); else state.zones[toZone].push(card);
}

/** LOCAL LOGIC **/
function logToUI(msg) { const log = document.getElementById('log'); log.innerHTML = `<div>> ${msg}</div>` + log.innerHTML; }
function rollDice(sides) { requestAction('ROLL_DICE', { sides, result: Math.floor(Math.random() * sides) + 1 }); }
function rollCoin() { requestAction('ROLL_DICE', { sides: 'Coin', result: Math.random() > 0.5 ? 'Heads' : 'Tails' }); }

function getManaString(role) {
	if(!state.mana || !state.mana[role]) return '';
	const m = state.mana[role];
	let s = '';
	if(m.W > 0) s += `<span style="color:#fff;text-shadow:1px 1px 2px #000;margin-right:4px;">☀️${m.W}</span>`;
	if(m.U > 0) s += `<span style="color:#4dabf7;text-shadow:1px 1px 2px #000;margin-right:4px;">💧${m.U}</span>`;
	if(m.B > 0) s += `<span style="color:#888;text-shadow:1px 1px 2px #000;margin-right:4px;">💀${m.B}</span>`;
	if(m.R > 0) s += `<span style="color:#ff6b6b;text-shadow:1px 1px 2px #000;margin-right:4px;">🔥${m.R}</span>`;
	if(m.G > 0) s += `<span style="color:#40c057;text-shadow:1px 1px 2px #000;margin-right:4px;">🌳${m.G}</span>`;
	if(m.C > 0) s += `<span style="color:#ccc;text-shadow:1px 1px 2px #000;">⟡${m.C}</span>`;
	return s.trim() ? `<div style="font-size:0.85rem; margin-top:4px; background:rgba(0,0,0,0.4); padding:2px 6px; border-radius:4px; display:inline-block;">${s}</div>` : '';
}

/** DYNAMIC RENDERING (4 PLAYER SUPPORT) **/
function buildOpponentsHTML() {
	const row = document.getElementById('opponents-row');
	row.innerHTML = '';
	
	const myIndex = state.players.indexOf(myRole);
	if (myIndex === -1) return;

	let opps = [];
	for (let i = 1; i < state.players.length; i++) {
		opps.push(state.players[(myIndex + i) % state.players.length]);
	}

	opps.forEach(oppId => {
		const b = document.createElement('div'); b.className = 'opp-block';
		b.innerHTML = `
			<div class="opp-play-container zone" id="play_${oppId}">
				<div class="zone-title">${state.names[oppId]}'s Play</div><div class="zone-count" id="count_play_${oppId}">0</div>
			</div>
			<div class="opp-side-panels">
				<div class="side-zone side-deck" id="deck_${oppId}"><div class="zone-title">Deck</div><div class="zone-count" id="count_deck_${oppId}">0</div></div>
				<div class="side-zone" id="graveyard_${oppId}"><div class="zone-title">Grave</div><div class="zone-count" id="count_graveyard_${oppId}">0</div></div>
				<div class="side-zone" id="exile_${oppId}"><div class="zone-title">Exile</div><div class="zone-count" id="count_exile_${oppId}">0</div></div>
				<div class="side-zone" id="command_${oppId}"><div class="zone-title">Cmd</div><div class="zone-count" id="count_command_${oppId}">0</div></div>
			</div>`;
		row.appendChild(b);
	});
	updateLifeUI();
}

function updateLifeUI() {
	const lc = document.getElementById('dynamic-life-container');
	const myHandCount = state.zones['hand_'+myRole] ? state.zones['hand_'+myRole].length : 0;
	
	lc.innerHTML = `
		<div class="life-row">
			<div style="display:flex; flex-direction:column; align-items:flex-start;">
				<span>${state.names[myRole] || 'Me'} <span style="font-size: 0.8rem; color: #bbb;">(🖐️ ${myHandCount})</span></span>
				${getManaString(myRole)}
			</div>
			<div>
				<button class="life-btn" onclick="requestAction('ADJUST_LIFE', {target: '${myRole}', amount: -1})">-</button>
				<span style="display:inline-block; width: 35px; text-align: center; color: white;">${state.life[myRole] ?? 20}</span>
				<button class="life-btn" onclick="requestAction('ADJUST_LIFE', {target: '${myRole}', amount: 1})">+</button>
			</div>
		</div>`;
		
	state.players.forEach(p => {
		if(p === myRole) return;
		const pHandCount = state.zones['hand_'+p] ? state.zones['hand_'+p].length : 0;
		lc.innerHTML += `
		<div class="life-row">
			<div style="display:flex; flex-direction:column; align-items:flex-start;">
				<span style="color:#aaa">${state.names[p]} <span style="font-size: 0.8rem; color: #888;">(🖐️ ${pHandCount})</span></span>
				${getManaString(p)}
			</div>
			<div>
				<button class="life-btn" onclick="requestAction('ADJUST_LIFE', {target: '${p}', amount: -1})">-</button>
				<span style="display:inline-block; width: 35px; text-align: center; color: white;">${state.life[p] ?? 20}</span>
				<button class="life-btn" onclick="requestAction('ADJUST_LIFE', {target: '${p}', amount: 1})">+</button>
			</div>
		</div>`;
	});
}

function renderAll() {
	if (document.querySelectorAll('.opp-block').length !== state.players.length - 1) buildOpponentsHTML();
	else updateLifeUI();

	['play', 'hand', 'deck', 'graveyard', 'exile', 'command'].forEach(z => {
		const elId = z === 'play' || z === 'hand' ? `my-${z}-zone` : `my-${z}-zone`;
		const c = document.getElementById(elId);
		if (c) c.setAttribute('data-zone-id', `${z}_${myRole}`);
		renderZone(state.zones[`${z}_${myRole}`], elId, false);
	});

	state.players.forEach(p => {
		if (p === myRole) return;
		['play', 'deck', 'graveyard', 'exile', 'command'].forEach(z => {
			const zEl = document.getElementById(`${z}_${p}`);
			if (zEl) zEl.setAttribute('data-zone-id', `${z}_${p}`);
			renderZone(state.zones[`${z}_${p}`], `${z}_${p}`, z === 'deck');
		});
	});

	if (document.getElementById('search-deck-modal').style.display === 'flex' && currentSearchZoneKey) refreshSearchModalContent();
	renderSelectionHighlight();

	// Render Playmats for all players
	if (state.playmats) {
		state.players.forEach(p => {
			const zoneEl = (p === myRole) ? document.getElementById('my-play-zone') : document.getElementById(`play_${p}`);
			if (zoneEl) {
				const url = state.playmats[p] || '';
				if (url) {
					zoneEl.style.backgroundImage = `url('${url}')`;
					zoneEl.style.backgroundSize = 'contain';
					zoneEl.style.backgroundPosition = 'center';
				} else {
					zoneEl.style.backgroundImage = 'none';
				}
			}
		});
	}

}

function renderSelectionHighlight() {
	document.querySelectorAll('.card.selected').forEach(c => c.classList.remove('selected'));
	selectedCardIds.forEach(id => { const e = document.getElementById(id); if (e) e.classList.add('selected'); });
}

function getCardOwnerRole(cId) {
	if (!cId) return myRole;
	if (cId.startsWith('my-')) return myRole;
	const parts = cId.split('_');
	for (let part of parts) {
		if (state.players && state.players.includes(part)) return part;
	}
	return myRole;
}

function renderZone(arr, containerId, forceDown = false) {
	const el = document.getElementById(containerId);
	if (!el) return;
	
	const countEl = el.querySelector('.zone-count');
	if (countEl) countEl.innerText = arr ? arr.length : 0;
	if (!arr || arr.length === 0) {
		el.querySelectorAll('.card').forEach(c => c.remove());
		return;
	}

	const ownerRole = containerId.startsWith('my-') ? myRole : (containerId.split('_')[1] || getCardOwnerRole(containerId));
	const isStack = containerId.includes('deck') || containerId.includes('graveyard') || containerId.includes('exile') || containerId.includes('command');
	
	let cardsToRender = isStack ? [{ ...arr[arr.length - 1] }] : arr;
	const newIds = new Set(cardsToRender.map(c => c.id));
	
	// 1. Remove deleted/moved cards
	el.querySelectorAll('.card').forEach(c => {
		if (!newIds.has(c.id)) {
			if (hoveringCard && hoveringCard.id === c.id) {
				hoveringCard = null;
				document.getElementById('hover-zoom-display').style.display = 'none';
			}
			c.remove();
		}
	});

	// 2. Smartly append or update cards
	cardsToRender.forEach(card => {
		let existingDom = document.getElementById(card.id);
		
		// Only skip rendering updates if it is actively being dragged AND not currently processing a drop
		if (existingDom && existingDom.classList.contains('dragging-active') && !window.isHandlingDrop) {
			return; 
		}
		
		// Recreate the DOM element if it doesn't exist or is in the wrong container
		if (!existingDom || existingDom.parentElement !== el) {
			if (existingDom) existingDom.remove();
			let c2 = { ...card }; if (forceDown) c2.facedown = true;
			
			const newCardDom = buildCardDOM(c2, containerId, ownerRole);
			
			// If this card was dropped onto a specific target card, place it right after that target in the DOM to layer on top
			if (card.targetCardId && containerId.includes('play')) {
				const targetDom = document.getElementById(card.targetCardId);
				if (targetDom && targetDom.parentElement === el) {
					targetDom.after(newCardDom);
				} else {
					el.appendChild(newCardDom);
				}
			} else {
				el.appendChild(newCardDom);
			}
		} else {
			// Update physical position without destroying the active DOM element
			if (containerId === 'my-play-zone' || containerId.startsWith('play_')) {
				let xp = card.x !== undefined ? card.x : 0.5;
				let yp = card.y !== undefined ? card.y : 0.5;
				if (xp > 2) { xp = xp / 2314; yp = yp / 525; } 
				existingDom.style.left = (xp * 100) + '%';
				existingDom.style.top = (yp * 100) + '%';
				
				// Optional: If you want to bump it to the end of the DOM stack on update so it layers on top:
				el.appendChild(existingDom);
			}
			
			// Re-apply classes
			if (card.rotated) existingDom.classList.add('rotated');
			else existingDom.classList.remove('rotated');

			let shouldBeFacedown = card.facedown || forceDown;
			if (shouldBeFacedown && !existingDom.classList.contains('facedown')) {
				existingDom.classList.add('facedown');
				const cbUrl = (state.cardBacks && state.cardBacks[ownerRole]) ? state.cardBacks[ownerRole] : '';
				if (cbUrl) {
					existingDom.style.setProperty('background', `url('${cbUrl}')`, 'important');
					existingDom.style.setProperty('background-size', '100% 100%', 'important');
					existingDom.style.setProperty('background-position', 'center', 'important');
				} else {
					existingDom.style.setProperty('background', 'repeating-linear-gradient(45deg, #2b4162, #2b4162 10px, #1a283d 10px, #1a283d 20px)', 'important');
					existingDom.style.setProperty('background-size', '100% 100%', 'important');
				}
				existingDom.innerText = '';
				existingDom.style.backgroundImage = '';
			} else if (!shouldBeFacedown && existingDom.classList.contains('facedown')) {
				let c2 = { ...card }; 
				existingDom.replaceWith(buildCardDOM(c2, containerId, ownerRole));
			} else {
				let oldCounters = existingDom.dataset.counters || '{}';
				let newCounters = JSON.stringify({ 
					c: card.counters || {}, 
					l: card.customCounterLabel || null 
				});
				if (oldCounters !== newCounters) {
					existingDom.dataset.counters = newCounters;
					let c2 = { ...card }; if (forceDown) c2.facedown = true;
					existingDom.replaceWith(buildCardDOM(c2, containerId, ownerRole));
				}
			}
		}
	});
}

function buildCardDOM(card, cId, explicitOwner = null) {
	const div = document.createElement('div'); div.className = 'card'; div.id = card.id;
	const ownerRole = explicitOwner || getCardOwnerRole(cId);

	if (cId && (cId.includes(myRole) || cId.startsWith('my-') || ownerRole === myRole)) {
		div.draggable = true;
		div.classList.add('my-card');
	}
	
	if (cId === 'my-play-zone' || cId.startsWith('play_')) { 
		div.style.position = 'absolute';
		let xp = card.x !== undefined ? card.x : 0.5;
		let yp = card.y !== undefined ? card.y : 0.5;
		
		if (xp > 2) { xp = xp / 2314; yp = yp / 525; } 

		div.style.left = (xp * 100) + '%';
		div.style.top = (yp * 100) + '%';
		div.style.margin = '0'; 
	}
	
	if (card.facedown) {
		div.classList.add('facedown');
		const cbUrl = (state.cardBacks && state.cardBacks[ownerRole]) ? state.cardBacks[ownerRole] : '';
		if (cbUrl) {
			div.style.setProperty('background', `url('${cbUrl}')`, 'important');
			div.style.setProperty('background-size', '100% 100%', 'important');
			div.style.setProperty('background-position', 'center', 'important');
		} else {
			div.style.setProperty('background', 'repeating-linear-gradient(45deg, #2b4162, #2b4162 10px, #1a283d 10px, #1a283d 20px)', 'important');
			div.style.setProperty('background-size', '100% 100%', 'important');
		}
	} else { 
		if (card.isToken) {
			div.style.backgroundColor = card.tokenColorBg || '#eee';
			div.style.color = card.tokenColorText || '#000';
			div.style.display = 'flex';
			div.style.flexDirection = 'column';
			div.style.justifyContent = 'space-between';
			div.style.alignItems = 'stretch';
			div.style.padding = '10px';
			div.style.textAlign = 'left';
			div.style.backgroundImage = 'none';
			
			const titleDiv = document.createElement('div');
			titleDiv.style.cssText = 'font-weight: bold; font-size: 0.95rem; border-bottom: 1px solid rgba(0,0,0,0.2); padding-bottom: 3px; width: 100%; text-align: center; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;';
			titleDiv.innerText = card.tokenName || '';
			div.appendChild(titleDiv);

			const rulesDiv = document.createElement('div');
			rulesDiv.style.cssText = 'font-size: 0.8rem; font-weight: normal; flex: 1; display: flex; align-items: flex-start; padding-top: 6px; width: 100%; word-break: break-word; overflow: hidden;';
			rulesDiv.innerText = card.tokenRules || '';
			div.appendChild(rulesDiv);

			const footerDiv = document.createElement('div');
			footerDiv.style.cssText = 'display: flex; justify-content: flex-end; width: 100%; margin-top: auto;';
			if (card.tokenPt) {
				const ptBadge = document.createElement('div');
				ptBadge.style.cssText = 'background: rgba(0,0,0,0.2); padding: 2px 6px; border-radius: 4px; font-weight: bold; font-size: 0.85rem;';
				ptBadge.innerText = card.tokenPt;
				footerDiv.appendChild(ptBadge);
			}
			div.appendChild(footerDiv);
		} else if (card.imageUrl) {
			div.style.backgroundImage = `url('${card.imageUrl}')`; 
		} else { 
			div.innerText = card.name; 
		} 
	}
	if (card.rotated) div.classList.add('rotated');
	
	if (card.counters || card.customCounterLabel) {
		let blips = '';
		if (card.counters && card.counters.green > 0) blips += `<div class="counter-blip green">${card.counters.green}</div>`;
		if (card.counters && card.counters.red > 0) blips += `<div class="counter-blip red">${card.counters.red}</div>`;
		
		// NEW: Check for the custom label
		if (card.customCounterLabel) {
			blips += `<div class="counter-blip custom">${card.customCounterLabel}</div>`;
		}
		
		if (blips) { 
			const c = document.createElement('div'); 
			c.className = 'counters-container'; 
			c.innerHTML = blips; 
			div.appendChild(c); 
		}
	}

	div.addEventListener('mouseenter', (e) => {
		if (!card.facedown) {
			hoveringCard = card;
			const hz = document.getElementById('hover-zoom-display');
			hz.style.width = (200 * uiPrefs.zoomScale) + 'px';
			hz.style.height = (280 * uiPrefs.zoomScale) + 'px';
			hz.style.display = 'flex';
			if (card.isToken) {
				hz.style.backgroundImage = 'none';
				hz.style.backgroundColor = card.tokenColorBg || '#eee';
				hz.style.color = card.tokenColorText || '#000';
				hz.style.flexDirection = 'column';
				hz.style.justifyContent = 'space-between';
				hz.style.alignItems = 'stretch';
				hz.style.padding = '15px';
				hz.style.textAlign = 'left';
				hz.innerHTML = `
					<div style="font-weight: bold; font-size: 1.2rem; border-bottom: 1px solid rgba(0,0,0,0.2); padding-bottom: 6px; width: 100%; text-align: center; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${card.tokenName || ''}</div>
					<div style="font-size: 1rem; font-weight: normal; flex: 1; display: flex; align-items: flex-start; padding-top: 10px; width: 100%; word-break: break-word; overflow: hidden;">${card.tokenRules || ''}</div>
					<div style="display: flex; justify-content: flex-end; width: 100%; margin-top: auto;">
						${card.tokenPt ? `<div style="background: rgba(0,0,0,0.2); padding: 4px 10px; border-radius: 6px; font-weight: bold; font-size: 1.1rem;">${card.tokenPt}</div>` : ''}
					</div>
				`;
			} else if (card.imageUrl) {
				hz.style.backgroundImage = `url('${card.imageUrl}')`;
				hz.style.backgroundColor = '#eee';
				hz.innerHTML = '';
			} else {
				hz.style.backgroundImage = 'none';
				hz.style.backgroundColor = '#eee';
				hz.style.color = 'black';
				hz.style.flexDirection = 'column';
				hz.style.justifyContent = 'center';
				hz.style.padding = '15px';
				hz.innerText = card.name;
			}
		}
	});
	div.addEventListener('mouseleave', () => { hoveringCard = null; document.getElementById('hover-zoom-display').style.display = 'none'; });

	div.addEventListener('mousedown', (e) => { const rect = div.getBoundingClientRect(); dragOffsetX = (e.clientX - rect.left) / currentScale; dragOffsetY = (e.clientY - rect.top) / currentScale; });
	div.addEventListener('dragstart', (e) => {
		if (!cId.includes(myRole) && !cId.startsWith('my-') && ownerRole !== myRole) { e.preventDefault(); return; }
		if (cId === 'my-play-zone' || cId.startsWith('play_')) { div.classList.add('dragging-active'); const img = new Image(); img.src = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'; e.dataTransfer.setDragImage(img, 0, 0); }
		if (!selectedCardIds.has(card.id)) { selectedCardIds.clear(); selectedCardIds.add(card.id); renderSelectionHighlight(); }
		draggedCardIds = Array.from(selectedCardIds);
		e.dataTransfer.setData('text/plain', 'cards');
	});
	div.addEventListener('drag', (e) => {
		if (e.clientX === 0 && e.clientY === 0) return;
		if (cId === 'my-play-zone' || cId === `play_${myRole}`) {
			const rect = document.getElementById('my-play-zone').getBoundingClientRect();
			const logW = rect.width / currentScale;
			const logH = rect.height / currentScale;

			const px = ((e.clientX - rect.left) / currentScale) - dragOffsetX;
			const py = ((e.clientY - rect.top) / currentScale) - dragOffsetY;
			
			div.style.left = ((px / logW) * 100) + '%';
			div.style.top = ((py / logH) * 100) + '%';
		}
	});
	div.addEventListener('dragend', () => div.classList.remove('dragging-active'));
	return div;
}

window.addEventListener('mousemove', (e) => {
	if (hoveringCard && !isDraggingWidget) {
		const hz = document.getElementById('hover-zoom-display');
		let x = e.clientX + 20, y = e.clientY + 20;
		if (x + hz.offsetWidth > window.innerWidth) x = e.clientX - hz.offsetWidth - 20;
		if (y + hz.offsetHeight > window.innerHeight) y = e.clientY - hz.offsetHeight - 20;
		hz.style.left = x + 'px'; hz.style.top = y + 'px';
	}
});

/** SELECTION & DRAG-DROP **/
document.addEventListener('mousedown', (e) => {
	if (e.button !== 0 || e.target.closest('#widget-zone') || e.target.closest('.overlay-modal') || e.target.closest('#context-menu')) return;
	const cardEl = e.target.closest('.card');
	if (cardEl && (cardEl.closest('#my-center-zones') || cardEl.closest('#my-side-zones'))) {
		if (!e.shiftKey && !selectedCardIds.has(cardEl.id)) { selectedCardIds.clear(); selectedCardIds.add(cardEl.id); renderSelectionHighlight(); }
		else if (e.shiftKey) { selectedCardIds.has(cardEl.id) ? selectedCardIds.delete(cardEl.id) : selectedCardIds.add(cardEl.id); renderSelectionHighlight(); }
		return;
	}
	const zoneEl = e.target.closest('.zone') || e.target.closest('.side-zone');
	if (zoneEl && (zoneEl.id.startsWith('my-') || zoneEl.id.includes(myRole))) {
		isSelecting = true; selectStartX = e.pageX; selectStartY = e.pageY; currentSelectionZone = zoneEl;
		if (!selectionBox) { selectionBox = document.createElement('div'); selectionBox.id = 'selection-box'; document.body.appendChild(selectionBox); }
		selectionBox.style.left = selectStartX + 'px'; selectionBox.style.top = selectStartY + 'px'; selectionBox.style.width = '0px'; selectionBox.style.height = '0px'; selectionBox.style.display = 'block';
		if(!e.shiftKey) { selectedCardIds.clear(); renderSelectionHighlight(); }
	} else { selectedCardIds.clear(); renderSelectionHighlight(); }
});

document.addEventListener('mousemove', (e) => {
	if (!isSelecting || !selectionBox) return;
	selectionBox.style.left = Math.min(selectStartX, e.pageX) + 'px'; selectionBox.style.top = Math.min(selectStartY, e.pageY) + 'px';
	selectionBox.style.width = Math.abs(e.pageX - selectStartX) + 'px'; selectionBox.style.height = Math.abs(e.pageY - selectStartY) + 'px';
});

document.addEventListener('mouseup', (e) => {
	if (!isSelecting) return; isSelecting = false; if (selectionBox) selectionBox.style.display = 'none';
	if (currentSelectionZone) {
		const rect = { l: Math.min(selectStartX, e.pageX), r: Math.max(selectStartX, e.pageX), t: Math.min(selectStartY, e.pageY), b: Math.max(selectStartY, e.pageY) };
		currentSelectionZone.querySelectorAll('.card').forEach(c => { const cr = c.getBoundingClientRect(); if (!(rect.r < cr.left || rect.l > cr.right || rect.b < cr.top || rect.t > cr.bottom)) selectedCardIds.add(c.id); });
		renderSelectionHighlight();
	}
});

document.addEventListener('click', (e) => {
	if (e.button !== 0) return;
	const cardEl = e.target.closest('.card'); if (!cardEl) return;
	const zoneEl = cardEl.closest('.zone') || cardEl.closest('.side-zone');
	if (!zoneEl) return;
	
	const globalZ = zoneEl.getAttribute('data-zone-id') || zoneEl.id;
	if (!globalZ.includes(myRole)) return;
	
	if (globalZ.startsWith('graveyard') || globalZ.startsWith('exile') || globalZ.startsWith('command')) return;
	if (globalZ.startsWith('deck')) { requestAction('DRAW_CARDS', { amount: 1 }); return; }

	let ids = Array.from(selectedCardIds); if (ids.length === 0) ids = [cardEl.id];
	if (globalZ.startsWith('hand')) requestAction('MOVE_CARDS', { cardIds: ids, toZone: `play_${myRole}`, index: 'top' });
	else if (globalZ.startsWith('play')) requestAction('ROTATE_CARDS', { cardIds: ids });
});

function allowDrop(e) { e.preventDefault(); }
function drop(e) {
	e.preventDefault();
	const zId = e.currentTarget.getAttribute('data-zone-id') || e.currentTarget.id;
	if (!zId.includes(myRole)) return; 

	// Detect if dropped directly on top of another card
	const elementBelow = document.elementFromPoint(e.clientX, e.clientY);
	const targetCardElement = elementBelow ? elementBelow.closest('.card') : null;
	let targetCardId = null;
	if (targetCardElement && !draggedCardIds.includes(targetCardElement.id)) {
		targetCardId = targetCardElement.id;
	}

	let payload = { 
		cardIds: draggedCardIds, 
		toZone: zId, 
		index: 'top',
		targetCardId: targetCardId 
	};

	if (zId.startsWith('play')) {
		const rect = e.currentTarget.getBoundingClientRect();
		const logW = rect.width / currentScale;
		const logH = rect.height / currentScale;

		const px = ((e.clientX - rect.left) / currentScale) - dragOffsetX;
		const py = ((e.clientY - rect.top) / currentScale) - dragOffsetY;

		payload.x = px / logW;
		payload.y = py / logH;
	}
	if (draggedCardIds.length > 0) { window.isHandlingDrop = true; requestAction('MOVE_CARDS', payload); window.isHandlingDrop = false; draggedCardIds = []; }
}

/** SEARCH & MODALS **/
function openSearchDeckModal(limit = null, targetRole = myRole) { 
	currentSearchZoneKey = `deck_${targetRole}`; 
	currentSearchLimit = limit; 
	topXActiveSession = null; 
	topXModalZone = null; 
	refreshSearchModalContent(); 
}
function openZoneSearchModal(zoneType, owner) { 
	currentSearchZoneKey = `${zoneType}_${owner}`; 
	currentSearchLimit = null; 
	topXActiveSession = null; 
	topXModalZone = null; 
	refreshSearchModalContent(); 
}
function closeSearchDeckModal() { 
    document.getElementById('search-modal-filter').value = '';
    
    if (currentSearchZoneKey) {
        const [zType, zOwner] = currentSearchZoneKey.split('_');
        // Check if it's a deck and the shuffle checkbox is checked
        if (zType === 'deck' && document.getElementById('shuffle-after-search').checked) {
            requestAction('SHUFFLE_DECK', { targetPlayer: zOwner });
        }
    }
    
    document.getElementById('search-deck-modal').style.display = 'none'; 
    currentSearchZoneKey = null; 
    topXActiveSession = null; 
    topXModalZone = null;
}

function filterSearchModal() {
	const term = document.getElementById('search-modal-filter').value.toLowerCase();
	const grid = document.getElementById('search-deck-grid');
	const wrappers = grid.querySelectorAll('.search-modal-card-wrapper');
	
	wrappers.forEach(w => {
		const name = w.getAttribute('data-card-name').toLowerCase();
		w.style.display = name.includes(term) ? 'flex' : 'none';
	});
}

function refreshSearchModalContent() {
	if (!currentSearchZoneKey) return;
	const arr = state.zones[currentSearchZoneKey] || [];
	const [zType, zOwner] = currentSearchZoneKey.split('_');
	const isDeckZone = zType === 'deck';

	let title = `Search ${state.names[zOwner]}'s ${zType.charAt(0).toUpperCase() + zType.slice(1)}`;
	if (currentSearchLimit) title = `Top ${currentSearchLimit} of ${title}`;

	document.getElementById('search-deck-title').innerHTML = `${title} (<span id="search-deck-count">${arr.length}</span> cards)`;
	document.getElementById('shuffle-checkbox-container').style.display = isDeckZone ? 'flex' : 'none';

	const grid = document.getElementById('search-deck-grid'); grid.innerHTML = '';
	if (arr.length === 0) { grid.innerHTML = `<div style="color:#888;width:100%;text-align:center;margin-top:50px;">Empty zone.</div>`; return; }

	let viewArr;
	if (currentSearchLimit) {
		if (!topXActiveSession || topXModalZone !== currentSearchZoneKey) {
			topXActiveSession = arr.slice(-currentSearchLimit);
			topXModalZone = currentSearchZoneKey;
		}
		// Keep only the cards from the initial snapshot that still exist in the deck
		const zoneCardIds = new Set(arr.map(c => c.id));
		topXActiveSession = topXActiveSession.filter(c => zoneCardIds.has(c.id));
		viewArr = topXActiveSession;
	} else {
		viewArr = arr;
	}

	if (viewArr.length === 0) { grid.innerHTML = `<div style="color:#888;width:100%;text-align:center;margin-top:50px;">No cards remaining in view.</div>`; return; }

	viewArr.slice().reverse().forEach(card => {
		const w = document.createElement('div'); w.style.cssText = 'display:flex;flex-direction:column;align-items:center;gap:8px;background:rgba(255,255,255,0.05);padding:12px;border-radius:8px;border:1px solid #444;';
		w.className = 'search-modal-card-wrapper';
		w.setAttribute('data-card-name', card.name || card.tokenName || '');

		// Temporarily display the player's own deck cards face up in the modal view
		let displayCard = { ...card };
		if (currentSearchZoneKey.startsWith('deck')) { // Changed from `deck_${myRole}`
			displayCard.facedown = false;
		}

		const c = buildCardDOM(displayCard, currentSearchZoneKey, zOwner);
		if (displayCard.facedown && zOwner !== myRole) { c.classList.add('facedown'); }
		w.appendChild(c);

			// Create action buttons for the searched cards
			const acts = document.createElement('div'); 
			acts.style.cssText = 'display:flex;gap:6px;flex-wrap:wrap;justify-content:center;width:200px;';
			acts.innerHTML = `
				<button onclick="requestAction('MOVE_CARDS', {cardIds:['${card.id}'],toZone:'hand_${zOwner}',index:'top'})" style="background:#2b4162;color:#fff;border:none;padding:5px 8px;border-radius:4px;cursor:pointer;">Hand</button>
				<button onclick="requestAction('MOVE_CARDS', {cardIds:['${card.id}'],toZone:'play_${zOwner}',index:'top'})" style="background:#3b7b4b;color:#fff;border:none;padding:5px 8px;border-radius:4px;cursor:pointer;">Play</button>
				<button onclick="requestAction('MOVE_CARDS', {cardIds:['${card.id}'],toZone:'graveyard_${zOwner}',index:'top'})" style="background:#555;color:#fff;border:none;padding:5px 8px;border-radius:4px;cursor:pointer;">Grave</button>
				<button onclick="requestAction('MOVE_CARDS', {cardIds:['${card.id}'],toZone:'exile_${zOwner}',index:'top'})" style="background:#555;color:#fff;border:none;padding:5px 8px;border-radius:4px;cursor:pointer;">Exile</button>
				<button onclick="requestAction('MOVE_CARDS', {cardIds:['${card.id}'],toZone:'command_${zOwner}',index:'top'})" style="background:#555;color:#fff;border:none;padding:5px 8px;border-radius:4px;cursor:pointer;">Command</button>
				<button onclick="requestAction('MOVE_CARDS', {cardIds:['${card.id}'],toZone:'deck_${zOwner}',index:'top'})" style="background:#555;color:#fff;border:none;padding:5px 8px;border-radius:4px;cursor:pointer;">Top of Deck</button>
				<button onclick="requestAction('MOVE_CARDS', {cardIds:['${card.id}'],toZone:'deck_${zOwner}',index:'bottom'})" style="background:#555;color:#fff;border:none;padding:5px 8px;border-radius:4px;cursor:pointer;">Bottom of Deck</button>
			`;
			w.appendChild(acts);
		grid.appendChild(w);
	});
	document.getElementById('search-deck-modal').style.display = 'flex';
}

function confirmNewGame() {
	if (!myInitialDeck) { alert("Please import a deck first."); return; }
	requestAction('RESET_GAME', { deck: myInitialDeck });
	document.getElementById('new-game-modal').style.display = 'none';
}

function submitTopXSearch() {
	const v = parseInt(document.getElementById('top-x-input').value) || 5;
	document.getElementById('top-x-modal').style.display = 'none';
	openSearchDeckModal(v, topXTargetRole || myRole);
}

/** MEDIA IMPORTS (Scryfall, Playmats, Paste) **/
async function importTextDeck() {
	const btn = document.querySelector('#import-overlay button'); 
	btn.innerText = "Fetching from Scryfall..."; 
	btn.disabled = true;

	const text = document.getElementById('deck-list').value;
	const lines = text.split('\n').map(l => l.trim());

	// Extract only lines between "Deck" and "Sideboard" headers
	let mainDeckLines = [];
	let capturing = false;
	let foundDeckHeader = false;

	for (let line of lines) {
		const lower = line.toLowerCase();
		if (lower === 'deck' || lower === 'deck:') {
			capturing = true;
			foundDeckHeader = true;
			continue;
		}
		if (lower === 'sideboard' || lower === 'sideboard:' || lower.startsWith('sideboard')) {
			capturing = false;
			break;
		}
		if (capturing && line !== '') {
			mainDeckLines.push(line);
		}
	}

	// Fallback: If no "Deck" header was found in the paste, default to using all non-empty lines
	if (!foundDeckHeader) {
		mainDeckLines = lines.filter(l => l !== '');
	}

	const reqs = [];
	mainDeckLines.forEach(line => {
		let qty = 1, cardStr = line;
		let match = line.match(/^(\d+)\s+(.+)$/); 
		if (match) { 
			qty = parseInt(match[1]); 
			cardStr = match[2].trim(); 
		}
		let setMatch = cardStr.match(/(.+?)\s+\((.+?)\)\s+(\S+)/); 
		let idObj = setMatch ? { set: setMatch[2].toLowerCase(), collector_number: setMatch[3].toString() } : { name: cardStr.split('//')[0].trim() };
		reqs.push({ qty, idObj, originalName: setMatch ? setMatch[1].trim() : cardStr });
	});

	const identifiers = Array.from(new Map(reqs.map(r => [r.idObj.name || (r.idObj.set + r.idObj.collector_number), r.idObj])).values());
	let resolved = {}; 

	for (let i = 0; i < identifiers.length; i += 75) {
		try {
			const res = await fetch('https://api.scryfall.com/cards/collection', { 
				method: 'POST', 
				headers: { 'Content-Type': 'application/json' }, 
				body: JSON.stringify({ identifiers: identifiers.slice(i, i + 75) }) 
			});
			const data = await res.json();
			if (data.data) {
				data.data.forEach((scry) => {
					let img = (scry.image_uris && scry.image_uris.normal) || (scry.card_faces && scry.card_faces[0].image_uris && scry.card_faces[0].image_uris.normal) || '';
					if (scry.name) { 
						resolved[scry.name.toLowerCase()] = img; 
						if (scry.name.includes('//')) resolved[scry.name.split('//')[0].trim().toLowerCase()] = img; 
					}
				});
			}
		} catch (e) {}
	}

	let newCards = [];
	reqs.forEach(req => { 
		const img = resolved[(req.idObj.name || req.originalName).toLowerCase()] || ''; 
		for (let i = 0; i < req.qty; i++) {
			newCards.push({ name: req.originalName, imageUrl: img, facedown: true, rotated: false }); 
		}
	});

	document.getElementById('import-overlay').style.display = 'none';
	if (newCards.length > 0) { 
		myInitialDeck = JSON.parse(JSON.stringify(newCards)); 
		requestAction('RESET_GAME', { deck: myInitialDeck }); 
	}

	btn.innerText = "Conjure Deck"; 
	btn.disabled = false;
}

async function submitCreateCardText() {
	const input = document.getElementById('create-card-input').value; if (!input || !input.trim()) return;
	const btn = document.querySelector('#create-card-modal button[onclick="submitCreateCardText()"]');
	btn.innerText = "Fetching from Scryfall..."; btn.disabled = true;
	
	const lines = input.split('\n').map(l => l.trim()).filter(l => l);
	const reqs = [];
	lines.forEach(line => {
		let qty = 1, cardStr = line;
		let match = line.match(/^(\d+)\s+(.+)$/); if (match) { qty = parseInt(match[1]); cardStr = match[2].trim(); }
		let setMatch = cardStr.match(/(.+?)\s+\((.+?)\)\s+(\S+)/); 
		let idObj = setMatch ? { set: setMatch[2].toLowerCase(), collector_number: setMatch[3].toString() } : { name: cardStr.split('//')[0].trim() };
		reqs.push({ qty, idObj, originalName: setMatch ? setMatch[1].trim() : cardStr });
	});
	
	const identifiers = Array.from(new Map(reqs.map(r => [r.idObj.name || (r.idObj.set + r.idObj.collector_number), r.idObj])).values());
	let resolved = {}; 
	for(let i=0; i < identifiers.length; i+=75) {
		try {
			const res = await fetch('https://api.scryfall.com/cards/collection', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ identifiers: identifiers.slice(i, i+75) }) });
			const data = await res.json();
			if (data.data) data.data.forEach((scry) => {
				let img = (scry.image_uris && scry.image_uris.normal) || (scry.card_faces && scry.card_faces[0].image_uris && scry.card_faces[0].image_uris.normal) || '';
				if (scry.name) { resolved[scry.name.toLowerCase()] = img; if (scry.name.includes('//')) resolved[scry.name.split('//')[0].trim().toLowerCase()] = img; }
			});
		} catch (e) {}
	}
	
	let newCards = [];
	reqs.forEach(req => { 
		const img = resolved[(req.idObj.name || req.originalName).toLowerCase()] || ''; 
		for(let i=0; i<req.qty; i++) newCards.push({ name: req.originalName, imageUrl: img, facedown: false, rotated: false }); 
	});
	
	document.getElementById('create-card-modal').style.display = 'none';
	if(newCards.length > 0 && activeCreateZone) requestAction('IMPORT_CARDS', { cards: newCards, zone: activeCreateZone });
	
	btn.innerText = "Create Text Card(s)"; btn.disabled = false;
}

function submitCreateToken() {
	const name = document.getElementById('token-name-input').value.trim();
	const colorKey = document.getElementById('token-color-select').value;
	const rules = document.getElementById('token-rules-input').value.trim();
	const pt = document.getElementById('token-pt-input').value.trim();

	let bg = '#4a5568';
	let textCol = '#ffffff';

	switch(colorKey) {
		case 'white': bg = '#f8f9fa'; textCol = '#212529'; break;
		case 'blue': bg = '#2b6cb0'; textCol = '#ffffff'; break;
		case 'black': bg = '#1a202c'; textCol = '#ffffff'; break;
		case 'red': bg = '#c53030'; textCol = '#ffffff'; break;
		case 'green': bg = '#276749'; textCol = '#ffffff'; break;
		case 'gray': bg = '#4a5568'; textCol = '#ffffff'; break;
	}

	const newToken = {
		name: name || 'Token',
		isToken: true,
		tokenName: name,
		tokenColorBg: bg,
		tokenColorText: textCol,
		tokenRules: rules,
		tokenPt: pt,
		facedown: false,
		rotated: false
	};

	document.getElementById('create-token-modal').style.display = 'none';
	if (activeCreateZone) {
		requestAction('IMPORT_CARDS', { cards: [newToken], zone: activeCreateZone });
	}
}

function importPokerDeck() {
	let newCards = [];
	['Hearts', 'Diamonds', 'Clubs', 'Spades'].forEach(s => ['2','3','4','5','6','7','8','9','10','J','Q','K','A'].forEach(v => newCards.push({ name: `${v} of ${s}`, imageUrl: '', facedown: true, rotated: false })));
	document.getElementById('import-overlay').style.display = 'none';
	myInitialDeck = JSON.parse(JSON.stringify(newCards)); requestAction('RESET_GAME', { deck: myInitialDeck });
}

function handleImagePaste(e, boxEl) {
	const items = (e.clipboardData || e.originalEvent.clipboardData).items;
	for (let item of items) {
		if (item.type.indexOf('image') === 0) {
			const reader = new FileReader();
			reader.onload = function(event) {
				const dataUrl = event.target.result;
				boxEl.closest('[data-image-url]').dataset.imageUrl = dataUrl;
				boxEl.style.backgroundImage = `url('${dataUrl}')`; boxEl.style.backgroundSize = 'contain'; boxEl.style.backgroundRepeat = 'no-repeat'; boxEl.style.backgroundPosition = 'center'; boxEl.innerText = '';
			};
			reader.readAsDataURL(item.getAsFile()); e.preventDefault(); break;
		}
	}
}

function handlePlaymatPaste(e, boxEl) {
	const items = (e.clipboardData || e.originalEvent.clipboardData).items;
	for (let item of items) {
		if (item.type.indexOf('image') === 0) {
			const reader = new FileReader();
			reader.onload = function(event) {
				pendingPlaymatUrl = event.target.result;
				boxEl.style.backgroundImage = `url('${pendingPlaymatUrl}')`; boxEl.style.backgroundSize = 'contain'; boxEl.style.backgroundRepeat = 'no-repeat'; boxEl.style.backgroundPosition = 'center'; boxEl.innerText = '';
			};
			reader.readAsDataURL(item.getAsFile()); e.preventDefault(); break;
		}
	}
}

function applyPlaymat() {
	if (pendingPlaymatUrl) {
		requestAction('SET_PLAYMAT', { playmatUrl: pendingPlaymatUrl });
	}
	document.getElementById('import-playmat-modal').style.display='none';
}

function clearPlaymat() {
	pendingPlaymatUrl = '';
	requestAction('SET_PLAYMAT', { playmatUrl: '' });
	let box = document.getElementById('import-playmat-modal').querySelector('.paste-box');
	box.style.backgroundImage = 'none'; box.innerText = 'Click Here & Press Ctrl+V to Paste Image';
	document.getElementById('import-playmat-modal').style.display='none';
}

function handleCardBackPaste(e, boxEl) {
	const items = (e.clipboardData || e.originalEvent.clipboardData).items;
	for (let item of items) {
		if (item.type.indexOf('image') === 0) {
			const reader = new FileReader();
			reader.onload = function(event) {
				pendingCardBackUrl = event.target.result;
				boxEl.style.backgroundImage = `url('${pendingCardBackUrl}')`; boxEl.style.backgroundSize = 'contain'; boxEl.style.backgroundRepeat = 'no-repeat'; boxEl.style.backgroundPosition = 'center'; boxEl.innerText = '';
			};
			reader.readAsDataURL(item.getAsFile()); e.preventDefault(); break;
		}
	}
}

function applyCardBack() {
	if (pendingCardBackUrl) {
		requestAction('SET_CARD_BACK', { cardBackUrl: pendingCardBackUrl });
	}
	document.getElementById('import-cardback-modal').style.display='none';
}

function clearCardBack() {
	pendingCardBackUrl = '';
	requestAction('SET_CARD_BACK', { cardBackUrl: '' });
	let box = document.getElementById('import-cardback-modal').querySelector('.paste-box');
	box.style.backgroundImage = 'none'; box.innerText = 'Click Here & Press Ctrl+V to Paste Image';
	document.getElementById('import-cardback-modal').style.display='none';
}

function addImageImportRow() {
	const container = document.getElementById('image-imports-container');
	const row = document.createElement('div'); row.className = 'image-import-row'; row.style.cssText = 'display: flex; gap: 8px; align-items: center; margin-bottom: 8px;'; row.dataset.imageUrl = '';
	row.innerHTML = `<div class="paste-box" contenteditable="true" style="flex: 1; background: #111; border: 1px dashed #666; padding: 6px; color: #aaa; text-align: center; border-radius: 4px; outline: none; min-height: 30px; display: flex; align-items: center; justify-content: center;" onpaste="handleImagePaste(event, this)">Click & Press Ctrl+V to Paste Image</div><input type="number" class="image-card-qty" value="1" min="1" max="99" style="width: 50px;"><button type="button" onclick="this.parentElement.remove()" style="background: #8b0000; color: white; border: none; padding: 4px 8px; cursor: pointer; border-radius: 4px; font-weight: bold;">×</button>`;
	container.appendChild(row);
}
function addCreateImageRow() {
	const container = document.getElementById('create-image-imports-container');
	const row = document.createElement('div'); row.className = 'create-image-import-row'; row.style.cssText = 'display: flex; gap: 8px; align-items: center; margin-bottom: 8px;'; row.dataset.imageUrl = '';
	row.innerHTML = `<div class="paste-box" contenteditable="true" style="flex: 1; background: #111; border: 1px dashed #666; padding: 6px; color: #aaa; text-align: center; border-radius: 4px; outline: none; min-height: 30px; display: flex; align-items: center; justify-content: center;" onpaste="handleImagePaste(event, this)">Click & Press Ctrl+V to Paste Image</div><input type="number" class="create-image-card-qty" value="1" min="1" max="99" style="width: 50px;"><button type="button" onclick="this.parentElement.remove()" style="background: #8b0000; color: white; border: none; padding: 4px 8px; cursor: pointer; border-radius: 4px; font-weight: bold;">×</button>`;
	container.appendChild(row);
}
function importImageDeck() {
	let newCards = [];
	document.querySelectorAll('.image-import-row').forEach(row => {
		const url = row.dataset.imageUrl; const qty = parseInt(row.querySelector('.image-card-qty').value) || 1;
		if (url) for (let i = 0; i < qty; i++) newCards.push({ name: 'Image Card', imageUrl: url, facedown: true, rotated: false });
	});
	if (newCards.length === 0) return alert('Paste an image using Ctrl+V.');
	document.getElementById('import-overlay').style.display = 'none';
	myInitialDeck = JSON.parse(JSON.stringify(newCards)); requestAction('RESET_GAME', { deck: myInitialDeck });
}
function submitCreateCardImages() {
	let newCards = [];
	document.querySelectorAll('.create-image-import-row').forEach(row => {
		const url = row.dataset.imageUrl; const qty = parseInt(row.querySelector('.create-image-card-qty').value) || 1;
		if (url) for (let i = 0; i < qty; i++) newCards.push({ name: 'Image Card', imageUrl: url, facedown: false, rotated: false });
	});
	if (newCards.length === 0) return alert('Paste an image using Ctrl+V.');
	document.getElementById('create-card-modal').style.display = 'none';
	if (activeCreateZone) requestAction('IMPORT_CARDS', { cards: newCards, zone: activeCreateZone });
}

/** CONTEXT MENUS **/
const cm = document.getElementById('context-menu'); const cmOptions = document.getElementById('cm-options');
document.addEventListener('click', (e) => { if(!e.target.closest('#context-menu')) cm.style.display = 'none'; });

document.addEventListener('contextmenu', (e) => {
	e.preventDefault();
	const cardEl = e.target.closest('.card');
	const zoneEl = e.target.closest('.zone') || e.target.closest('.side-zone');
	cmOptions.innerHTML = '';
	
	if (cardEl) {
		const zUI = (zoneEl.getAttribute('data-zone-id') || zoneEl.id);
		if (!zUI.includes(myRole)) {
			const oppRole = zUI.split('_')[1];
			// Allow viewing Grave/Exile/Command
			if (zUI.includes('graveyard') || zUI.includes('exile') || zUI.includes('command')) {
				buildMenuOption("View All Cards", () => openZoneSearchModal(zUI.split('_')[0], oppRole));
			}
			// NEW: Allow Search on opponent's deck
			if (zUI.includes('deck')) {
				buildMenuOption("Search Deck", () => openSearchDeckModal(null, oppRole));
				buildMenuOption("Search Top X...", () => { 
					topXTargetRole = oppRole; 
					document.getElementById('top-x-modal').style.display='flex'; 
				});
			}
		} else {
			if (!selectedCardIds.has(cardEl.id)) { selectedCardIds.clear(); selectedCardIds.add(cardEl.id); renderSelectionHighlight(); }
			const tIds = Array.from(selectedCardIds); const bZone = zUI.split('_')[0];
			if (bZone === 'deck') {
				buildMenuOption("Search Deck", () => openSearchDeckModal());
				buildMenuOption("Search Top X...", () => { topXTargetRole = myRole; document.getElementById('top-x-modal').style.display='flex'; });
				buildMenuOption("Draw Card", () => requestAction('DRAW_CARDS', { amount: tIds.length }));
				buildMenuOption("Play", () => requestAction('MOVE_CARDS', { cardIds: tIds, toZone: `play_${myRole}`, index: 'top' }));
				buildMenuOption("Graveyard", () => requestAction('MOVE_CARDS', { cardIds: tIds, toZone: `graveyard_${myRole}`, index: 'top' }));
				buildMenuOption("Exile", () => requestAction('MOVE_CARDS', { cardIds: tIds, toZone: `exile_${myRole}`, index: 'top' }));
				buildMenuOption("Command", () => requestAction('MOVE_CARDS', { cardIds: tIds, toZone: `command_${myRole}`, index: 'top' }));
				buildMenuOption("Bottom of Deck", () => requestAction('MOVE_CARDS', { cardIds: tIds, toZone: `deck_${myRole}`, index: 'bottom' }));
				buildMenuOption("Bottom of Deck (Random)", () => requestAction('MOVE_CARDS_RANDOM_BOTTOM', { cardIds: tIds, toZone: `deck_${myRole}` }));
				buildMenuOption("Shuffle Deck", () => requestAction('SHUFFLE_DECK', {}));
				buildMenuOption("Flip Over", () => requestAction('FLIP_CARDS', { cardIds: tIds }));
			} else {
				if (['graveyard', 'exile', 'command'].includes(bZone)) buildMenuOption("View All Cards", () => openZoneSearchModal(bZone, myRole));
				buildMenuOption("Play", () => requestAction('MOVE_CARDS', { cardIds: tIds, toZone: `play_${myRole}`, index: 'top' }));
				buildMenuOption("Hand", () => requestAction('MOVE_CARDS', { cardIds: tIds, toZone: `hand_${myRole}`, index: 'top' }));
				buildMenuOption("Graveyard", () => requestAction('MOVE_CARDS', { cardIds: tIds, toZone: `graveyard_${myRole}`, index: 'top' }));
				buildMenuOption("Exile", () => requestAction('MOVE_CARDS', { cardIds: tIds, toZone: `exile_${myRole}`, index: 'top' }));
				buildMenuOption("Command", () => requestAction('MOVE_CARDS', { cardIds: tIds, toZone: `command_${myRole}`, index: 'top' }));
				buildMenuOption("Top of Deck", () => requestAction('MOVE_CARDS', { cardIds: tIds, toZone: `deck_${myRole}`, index: 'top' }));
				buildMenuOption("Bottom of Deck", () => requestAction('MOVE_CARDS', { cardIds: tIds, toZone: `deck_${myRole}`, index: 'bottom' }));
				buildMenuOption("Bottom of Deck (Random)", () => requestAction('MOVE_CARDS_RANDOM_BOTTOM', { cardIds: tIds, toZone: `deck_${myRole}` }));
				buildMenuOption("Shuffle into Deck", () => { requestAction('MOVE_CARDS', { cardIds: tIds, toZone: `deck_${myRole}`, index: 'top' }); requestAction('SHUFFLE_DECK', {}); });
				buildMenuOption("Flip Over", () => requestAction('FLIP_CARDS', { cardIds: tIds }));
				
				['green', 'red'].forEach(cType => {
					const li = document.createElement('li');
					li.style.cssText = 'display:flex;justify-content:space-between;align-items:center;padding:5px 15px;border-bottom:1px solid #333;cursor:default;';
					
					const span = document.createElement('span');
					span.innerText = cType.charAt(0).toUpperCase() + cType.slice(1) + ' Counter';
					li.appendChild(span);

					const btnContainer = document.createElement('div');
					btnContainer.style.cssText = 'display:flex;gap:8px;';

					const minusBtn = document.createElement('button');
					minusBtn.style.cssText = 'background:#444;color:white;border:1px solid #666;padding:2px 8px;border-radius:4px;cursor:pointer;';
					minusBtn.innerText = '-';
					minusBtn.onclick = (ev) => {
						ev.stopPropagation();
						requestAction('MODIFY_COUNTERS', { cardIds: tIds, cType: cType, amount: -1 });
					};

					const plusBtn = document.createElement('button');
					plusBtn.style.cssText = 'background:#444;color:white;border:1px solid #666;padding:2px 8px;border-radius:4px;cursor:pointer;';
					plusBtn.innerText = '+';
					plusBtn.onclick = (ev) => {
						ev.stopPropagation();
						requestAction('MODIFY_COUNTERS', { cardIds: tIds, cType: cType, amount: 1 });
					};

					const clearBtn = document.createElement('button');
					clearBtn.style.cssText = 'background:#8b0000;color:white;border:1px solid #aa0000;padding:2px 8px;border-radius:4px;cursor:pointer;';
					clearBtn.innerText = '🗑️';
					clearBtn.onclick = (ev) => {
						ev.stopPropagation();
						requestAction('CLEAR_COUNTER_TYPE', { cardIds: tIds, cType: cType });
					};

					btnContainer.appendChild(minusBtn);
					btnContainer.appendChild(plusBtn);
					btnContainer.appendChild(clearBtn);
					li.appendChild(btnContainer);
					cmOptions.appendChild(li);
				});
				buildMenuOption("Add Custom Label...", () => openCustomCounterModal());
				buildMenuOption("Clear Custom Label", () => requestAction('CLEAR_CUSTOM_COUNTER', { cardIds: tIds }));						
				buildMenuOption("Copy Card", () => requestAction('COPY_CARDS', { cardIds: tIds }));
				buildMenuOption("Delete Card(s)", () => requestAction('DELETE_CARDS', { cardIds: tIds }));
			}
		}
	} else if (zoneEl) {
		const zUI = (zoneEl.getAttribute('data-zone-id') || zoneEl.id);
		if (!zUI.includes(myRole)) {
			if (zUI.includes('graveyard') || zUI.includes('exile') || zUI.includes('command')) {
				buildMenuOption("View All Cards", () => openZoneSearchModal(zUI.split('_')[0], zUI.split('_')[1]));
			}
		} else {
			const bZone = zUI.split('_')[0];
			if (bZone === 'deck') { buildMenuOption("Search Deck", () => openSearchDeckModal()); buildMenuOption("Search Top X...", () => { topXTargetRole = myRole; document.getElementById('top-x-modal').style.display='flex'; }); }
			if (['graveyard', 'exile', 'command'].includes(bZone)) buildMenuOption("View All Cards", () => openZoneSearchModal(bZone, myRole));
			
			if (bZone === 'play') {
				buildMenuOption("Create Card(s)", () => { activeCreateZone = zUI; document.getElementById('create-card-input').value = ''; document.getElementById('create-card-modal').style.display = 'flex'; });
				buildMenuOption("Create Token", () => { activeCreateZone = zUI; document.getElementById('token-name-input').value = ''; document.getElementById('token-rules-input').value = ''; document.getElementById('token-pt-input').value = ''; document.getElementById('token-color-select').value = 'gray'; document.getElementById('create-token-modal').style.display = 'flex'; });
			} else {
				buildMenuOption("Create Card(s)", () => { activeCreateZone = zUI; document.getElementById('create-card-input').value = ''; document.getElementById('create-card-modal').style.display = 'flex'; });
			}
			
			// Specific logic for Mana Management in Player's Own Play Zone
			if (bZone === 'play') {
				const li = document.createElement('li');
				li.className = 'cm-submenu-parent';
				li.innerHTML = 'Add Mana ▸<ul class="cm-submenu"></ul>';
				const sub = li.querySelector('.cm-submenu');
				
				const manaColors = [
					{name: 'White', code: 'W'},
					{name: 'Blue', code: 'U'},
					{name: 'Black', code: 'B'},
					{name: 'Red', code: 'R'},
					{name: 'Green', code: 'G'},
					{name: 'Colorless', code: 'C'}
				];
				
				manaColors.forEach(c => {
					const subLi = document.createElement('li');
					subLi.style.cssText = 'display:flex;justify-content:space-between;align-items:center;padding:5px 15px;border-bottom:1px solid #333;cursor:default;';
					subLi.innerHTML = `<span>${c.name}</span>`;
					
					const btnContainer = document.createElement('div');
					btnContainer.style.cssText = 'display:flex;gap:8px;';
					
					const minusBtn = document.createElement('button'); minusBtn.innerText = '-';
					minusBtn.style.cssText = 'background:#444;color:white;border:1px solid #666;padding:2px 8px;border-radius:4px;cursor:pointer;';
					minusBtn.onclick = (ev) => { ev.stopPropagation(); requestAction('MODIFY_MANA', { target: myRole, color: c.code, amount: -1 }); };
					
					const plusBtn = document.createElement('button'); plusBtn.innerText = '+';
					plusBtn.style.cssText = 'background:#444;color:white;border:1px solid #666;padding:2px 8px;border-radius:4px;cursor:pointer;';
					plusBtn.onclick = (ev) => { ev.stopPropagation(); requestAction('MODIFY_MANA', { target: myRole, color: c.code, amount: 1 }); };

					const clearBtn = document.createElement('button'); clearBtn.innerText = '🗑️';
					clearBtn.style.cssText = 'background:#8b0000;color:white;border:1px solid #aa0000;padding:2px 8px;border-radius:4px;cursor:pointer;';
					clearBtn.onclick = (ev) => { ev.stopPropagation(); requestAction('MODIFY_MANA', { target: myRole, color: c.code, amount: 'clear' }); };

					btnContainer.append(minusBtn, plusBtn, clearBtn);
					subLi.appendChild(btnContainer);
					sub.appendChild(subLi);
				});
				cmOptions.appendChild(li);
			}
		}
	}
	if (cmOptions.children.length > 0) {
		cm.style.display = 'block';
		let l = e.pageX, t = e.pageY, r = cm.getBoundingClientRect();
		if (l + r.width > window.innerWidth) l = window.innerWidth - r.width - 10;
		if (t + r.height > window.innerHeight) t = window.innerHeight - r.height - 10;
		cm.style.left = Math.max(5, l) + 'px'; cm.style.top = Math.max(5, t) + 'px';
	}
});
function buildMenuOption(text, cb) { const li = document.createElement('li'); li.innerText = text; li.onclick = (e) => { e.stopPropagation(); cm.style.display = 'none'; cb(); }; cmOptions.appendChild(li); }

/** LIFE CHANGE WIZARD ANIMATION **/
function triggerLifeAnimation(targetRole, amount) {
	// Select the correct play zone container depending on whether it's you or an opponent
	const playZoneEl = (targetRole === myRole) 
		? document.getElementById('my-play-zone') 
		: document.getElementById('play_' + targetRole);

	if (!playZoneEl) return;

	const animEl = document.createElement('div');
	animEl.className = 'life-animation-popup';

	// Format the sign (+ or -) and text color (green for gain, red for loss)
	const signStr = amount > 0 ? `+${amount}` : `${amount}`;
	const colorClass = amount > 0 ? '#40c057' : '#ff6b6b';

	animEl.innerHTML = `🧙‍♂️ <span style="color: ${colorClass};">${signStr}</span>`;

	// Random starting position within the play zone bounds
	const startX = Math.random() * 60 + 20; // percentage
	const startY = Math.random() * 60 + 20; // percentage
	animEl.style.left = startX + '%';
	animEl.style.top = startY + '%';

	// Random directional drift variables for the CSS animation
	const randX = (Math.random() - 0.5) * 120 + 'px';
	const randY = (Math.random() - 0.5) * 120 - 40 + 'px';
	animEl.style.setProperty('--rand-x', randX);
	animEl.style.setProperty('--rand-y', randY);

	playZoneEl.appendChild(animEl);

	// Automatically remove the element after the 2-second animation concludes
	setTimeout(() => {
		animEl.remove();
	}, 2000);
}