// =================================================================================
// WebSocket セットアップ
// =================================================================================
const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
const ws = new WebSocket(`${wsProtocol}//${window.location.host}`);

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
const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];

// =================================================================================
// UI更新関数
// =================================================================================
function showToast(message, duration = 3000) {
    toastEl.textContent = message;
    toastEl.classList.add('show');
    setTimeout(() => toastEl.classList.remove('show'), duration);
}

function updateUI(data) {
    state.creatorId = data.creatorId;
    roomIdDisplay.textContent = data.roomId;

    // Player List
    playerList.innerHTML = '';
    Object.entries(data.players).forEach(([pid, player]) => {
        const li = document.createElement('li');
        li.textContent = `${player.name} (${player.cardCount}枚)`;
        if (pid === state.playerId) li.classList.add('is-self');
        if (data.gameState && pid === data.gameState.turnPlayerId) li.classList.add('is-turn');
        playerList.appendChild(li);
    });

    if (data.status === 'waiting') {
        if (state.playerId === state.creatorId) {
            newGameBtn.textContent = 'ゲーム開始';
            newGameBtn.style.display = 'block';
            newGameBtn.disabled = Object.keys(data.players).length < 2;
            gameOverOverlay.style.display = 'flex';
            winnerAnnouncement.textContent = 'プレイヤーを待っています...';
        } else {
            gameOverOverlay.style.display = 'flex';
            winnerAnnouncement.textContent = 'ホストがゲームを開始するのを待っています...';
            newGameBtn.style.display = 'none';
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
        playCardBtn.disabled = !isMyTurn || state.selectedCards.length === 0;
        challengeBtn.disabled = isMyTurn || !gs.lastPlayerId;

        if(gs.challengeResult) {
            const { challengerName, challengedName, wasLie, loserName } = gs.challengeResult;
            const msg = wasLie
                ? `座布団成功！ ${challengerName}の指摘通り！ ${loserName}が場のカードを全て引き取ります。`
                : `座布団失敗… ${challengedName}は正直でした！ ${loserName}が場のカードを全て引き取ります。`;
            showToast(msg, 4000);
        }
    }

    if (data.status === 'finished') {
        gameOverOverlay.style.display = 'flex';
        winnerAnnouncement.textContent = `勝者: ${data.players[data.gameState.winner].name}!`;
        newGameBtn.textContent = '新しいゲームを始める';
        newGameBtn.style.display = state.playerId === state.creatorId ? 'block' : 'none';
    }

    // Hand
    state.myHand = data.myHand || [];
    myCardCountEl.textContent = state.myHand.length;
    renderHand(data.status === 'playing' && data.gameState.turnPlayerId === state.playerId);
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

// =================================================================================
// WebSocket イベントリスナー
// =================================================================================
function sendMessage(type, payload = {}) {
    ws.send(JSON.stringify({ type, payload }));
}

ws.onopen = () => console.log('Connected to server');
ws.onclose = () => showToast('サーバーとの接続が切れました。ページをリロードしてください。');
ws.onerror = (err) => {
    console.error('WebSocket Error:', err);
    showToast('接続エラーが発生しました。');
};

ws.onmessage = (event) => {
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
};

// =================================================================================
// フロントエンド イベントリスナー
// =================================================================================
createRoomBtn.addEventListener('click', () => {
    sendMessage('createRoom', { playerId: state.playerId, playerName: state.playerName });
});

joinRoomBtn.addEventListener('click', () => {
    const roomId = roomIdInput.value.trim();
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

// =================================================================================
// 初期化
// =================================================================================
window.addEventListener('load', () => {
    state.playerId = localStorage.getItem('zabutonPlayerId') || 'player_' + Math.random().toString(36).substring(2, 9);
    localStorage.setItem('zabutonPlayerId', state.playerId);
    state.playerName = localStorage.getItem('zabutonPlayerName') || prompt("あなたの名前を入力してください:", "プレイヤー" + state.playerId.substring(7,11)) || "名無しさん";
    localStorage.setItem('zabutonPlayerName', state.playerName);
});