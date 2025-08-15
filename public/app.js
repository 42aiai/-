// =================================================================================
// WebSocket セットアップ
// =================================================================================
// Render.comは常にHTTPSなので、WebSocketも安全な 'wss:' を決め打ちで使う
const ws = new WebSocket(`wss://${window.location.host}`);

// =================================================================================
// グローバル状態管理
// =================================================================================
let state = {
    playerId: null,
    playerName: null,
    roomId: null,
    selectedCards: [],
    myHand: [],
    creatorId: null,
    settings: {},
    challengeTimerInterval: null,
};

// =================================================================================
// DOM要素
// =================================================================================
const lobby = document.getElementById('lobby');
const gameRoom = document.getElementById('game-room');
const createRoomBtn = document.getElementById('create-room-btn');
const joinRoomBtn = document.getElementById('join-room-btn');
const roomIdInput = document.getElementById('room-id-input');
const errorMessage = document.getElementById('error-message');
const roomIdDisplay = document.getElementById('room-id-display');
const playerList = document.getElementById('player-list');
const currentCallEl = document.getElementById('current-call');
const fieldCardCountEl = document.getElementById('field-card-count');
const turnPlayerNameEl = document.getElementById('turn-player-name');
const myHandContainer = document.getElementById('my-hand');
const myCardCountEl = document.getElementById('my-card-count');
const playCardBtn = document.getElementById('play-card-btn');
const challengeBtn = document.getElementById('challenge-btn');
const gameOverOverlay = document.getElementById('game-over-overlay');
const winnerAnnouncement = document.getElementById('winner-announcement');
const newGameBtn = document.getElementById('new-game-btn');
const toastEl = document.getElementById('toast');
const hostSettings = document.getElementById('host-settings');
const challengeTimeoutSelect = document.getElementById('challenge-timeout-select');
const challengeTimer = document.getElementById('challenge-timer');
const challengeTimerSeconds = document.getElementById('challenge-timer-seconds');
const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];


// =================================================================================
// UI更新関数
// =================================================================================
function showToast(message, duration = 4000) { // 少し長めに変更
    toastEl.textContent = message;
    toastEl.classList.add('show');
    setTimeout(() => toastEl.classList.remove('show'), duration);
}

function updateUI(data) {
    state.creatorId = data.creatorId;
    state.settings = data.settings;
    roomIdDisplay.textContent = data.roomId;

    playerList.innerHTML = '';
    Object.entries(data.players).forEach(([pid, player]) => {
        const li = document.createElement('li');
        li.textContent = `${player.name} (${player.cardCount}枚)`;
        if (pid === state.playerId) li.classList.add('is-self');
        if (data.gameState && pid === data.gameState.turnPlayerId) li.classList.add('is-turn');
        playerList.appendChild(li);
    });

    if (state.challengeTimerInterval) {
        clearInterval(state.challengeTimerInterval);
        state.challengeTimerInterval = null;
    }
    challengeTimer.style.display = 'none';
    if (data.status === 'playing' && data.gameState && data.gameState.challengePhase) {
        const amIChallenged = data.gameState.lastPlayerId === state.playerId;
        if (!amIChallenged) {
            challengeTimer.style.display = 'block';
            let secondsLeft = state.settings.challengeTimeoutSeconds;
            challengeTimerSeconds.textContent = secondsLeft;
            state.challengeTimerInterval = setInterval(() => {
                secondsLeft--;
                challengeTimerSeconds.textContent = Math.max(0, secondsLeft);
                if (secondsLeft <= 0) {
                    clearInterval(state.challengeTimerInterval);
                }
            }, 1000);
        }
    }

    if (data.status === 'waiting' || data.status === 'finished') {
        gameOverOverlay.style.display = 'flex';
        if (state.playerId === state.creatorId) {
            hostSettings.style.display = 'block';
            challengeTimeoutSelect.value = state.settings.challengeTimeoutSeconds;
            challengeTimeoutSelect.disabled = (data.status === 'finished');
            newGameBtn.style.display = 'block';
            newGameBtn.disabled = (data.status === 'waiting' && Object.keys(data.players).length < 2);
        } else {
            hostSettings.style.display = 'none';
            newGameBtn.style.display = 'none';
        }
        if (data.status === 'waiting') {
            winnerAnnouncement.textContent = 'プレイヤーを待っています...';
            newGameBtn.textContent = 'ゲーム開始';
        } else {
            winnerAnnouncement.textContent = `勝者: ${data.players[data.gameState.winner].name}!`;
            newGameBtn.textContent = '新しいゲームを始める';
        }
    } else {
        gameOverOverlay.style.display = 'none';
    }

    if (data.status === 'playing') {
        const gs = data.gameState;
        currentCallEl.textContent = RANKS[gs.currentCall - 1];
        fieldCardCountEl.textContent = gs.fieldCardCount;
        turnPlayerNameEl.textContent = data.players[gs.turnPlayerId].name;
        const isMyTurn = gs.turnPlayerId === state.playerId;
        playCardBtn.disabled = !isMyTurn || state.selectedCards.length === 0 || gs.challengePhase;
        challengeBtn.disabled = (gs.lastPlayerId === state.playerId) || !gs.challengePhase;

        // ▼▼▼ ここからがご要望の修正点です ▼▼▼
        if (gs.challengeResult) {
            const { challengedName, wasLie, loserName } = gs.challengeResult;
            let msg;
            if (wasLie) {
                // チャレンジ成功（嘘だった）場合のメッセージ
                msg = `座布団成功！ ${challengedName}は嘘をついていました！ ${loserName}が場のカードを全て引き取ります。`;
            } else {
                // チャレンジ失敗（正直だった）場合のメッセージ
                msg = `座布団失敗… ${challengedName}のプレイは正直でした！ ${loserName}が場のカードを全て引き取ります。`;
            }
            showToast(msg);
        }
        // ▲▲▲ ここまでがご要望の修正点です ▲▲▲
    }

    state.myHand = data.myHand || [];
    myCardCountEl.textContent = state.myHand.length;
    renderHand(data.status === 'playing' && data.gameState.turnPlayerId === state.playerId && !data.gameState.challengePhase);
}

function renderHand(isMyTurn) {
    myHandContainer.innerHTML = '';
    state.myHand.sort((a,b) => (a.isJoker ? 14 : a.rank) - (b.isJoker ? 14 : b.rank) || a.suit.localeCompare(b.suit)).forEach(card => {
        const cardEl = document.createElement('div');
        cardEl.classList.add('card');
        cardEl.dataset.cardId = card.id;
        if(card.isJoker) cardEl.classList.add('is-joker');
        const rank = card.isJoker ? 'JOKER' : RANKS[card.rank - 1];
        const suitChar = {s: '♠', h: '♥', d: '♦', c: '♣', j: ''}[card.suit];
        if(['h', 'd'].includes(card.suit) || card.isJoker) cardEl.style.color = 'red';
        cardEl.innerHTML = `<span>${rank}</span><span class="suit">${suitChar}</span>`;
        if (!isMyTurn) cardEl.classList.add('disabled');
        if (state.selectedCards.includes(card.id)) cardEl.classList.add('selected');
        cardEl.addEventListener('click', () => {
            if (!isMyTurn) return;
            toggleCardSelection(card.id, cardEl);
        });
        myHandContainer.appendChild(cardEl);
    });
}

function toggleCardSelection(cardId, cardEl) {
    const index = state.selectedCards.indexOf(cardId);
    if (index > -1) {
        state.selectedCards.splice(index, 1);
        cardEl.classList.remove('selected');
    } else {
        if (state.selectedCards.length < 4) {
            state.selectedCards.push(cardId);
            cardEl.classList.add('selected');
        } else {
            showToast("一度に4枚までしか選択できません。");
        }
    }
    playCardBtn.disabled = state.selectedCards.length === 0;
}

function sendMessage(type, payload = {}) {
    if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type, payload }));
    }
}

ws.onopen = () => console.log('Connected to server');
ws.onclose = () => showToast('サーバーとの接続が切れました。ページをリロードしてください。');
ws.onerror = (err) => {
    console.error('WebSocket Error:', err);
    showToast('接続エラーが発生しました。');
};

ws.onmessage = (event) => {
    try {
        const { type, payload } = JSON.parse(event.data);
        switch (type) {
            case 'roomCreated':
            case 'joinedRoom':
                state.roomId = payload.roomId;
                lobby.style.display = 'none';
                gameRoom.style.display = 'block';
                break;
            case 'updateState':
                updateUI(payload);
                break;
            case 'error':
                errorMessage.textContent = payload.message;
                showToast(payload.message);
                break;
        }
    } catch (error) {
        console.error("Failed to parse message from server:", event.data, error);
    }
};

createRoomBtn.addEventListener('click', () => {
    sendMessage('createRoom', { playerId: state.playerId, playerName: state.playerName });
});

joinRoomBtn.addEventListener('click', () => {
    const roomId = roomIdInput.value.trim().toUpperCase();
    if (roomId.length !== 6) {
        errorMessage.textContent = "6桁の部屋番号を入力してください。";
        return;
    }
    sendMessage('joinRoom', { roomId, playerId: state.playerId, playerName: state.playerName });
});

playCardBtn.addEventListener('click', () => {
    if (state.selectedCards.length > 0) {
        sendMessage('playCards', { cardIds: state.selectedCards });
        state.selectedCards = [];
        playCardBtn.disabled = true;
    }
});

challengeBtn.addEventListener('click', () => {
    sendMessage('challenge');
});

newGameBtn.addEventListener('click', () => {
    if (state.playerId === state.creatorId) {
        sendMessage('startGame');
    }
});

challengeTimeoutSelect.addEventListener('change', (e) => {
    sendMessage('changeSettings', {
        challengeTimeoutSeconds: e.target.value
    });
});

window.addEventListener('load', () => {
    state.playerId = localStorage.getItem('zabutonPlayerId') || 'player_' + Math.random().toString(36).substring(2, 9);
    localStorage.setItem('zabutonPlayerId', state.playerId);
    let storedName = localStorage.getItem('zabutonPlayerName');
    if (!storedName) {
        storedName = prompt("あなたの名前を入力してください:", "プレイヤー" + state.playerId.substring(7,11)) || "名無しさん";
        localStorage.setItem('zabutonPlayerName', storedName);
    }
    state.playerName = storedName;
});