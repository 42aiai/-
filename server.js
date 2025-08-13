const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');

// ================= 設定 =================
const PORT = process.env.PORT || 3000;
const MAX_PLAYERS = 6;
const USE_JOKERS = true;
const NUM_JOKERS = 2;

// ================= サーバーのセットアップ =================
const app = express();
app.use(express.static(path.join(__dirname, 'public')));
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// ================= ゲーム状態の管理 =================
let rooms = {}; // { roomId: { id, players, status, gameState, privateState } }

// ================= ヘルパー関数 =================

/** カードのデッキを作成 */
function createDeck() {
    const suits = ['s', 'h', 'd', 'c'];
    const ranks = Array.from({ length: 13 }, (_, i) => i + 1);
    let deck = [];
    for (const suit of suits) {
        for (const rank of ranks) {
            deck.push({ id: `${suit}${rank}`, suit, rank, isJoker: false });
        }
    }
    if (USE_JOKERS) {
        for (let i = 1; i <= NUM_JOKERS; i++) {
            deck.push({ id: `j${i}`, suit: 'j', rank: 0, isJoker: true });
        }
    }
    return deck;
}

/** デッキをシャッフル */
function shuffleDeck(deck) {
    for (let i = deck.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [deck[i], deck[j]] = [deck[j], deck[i]];
    }
    return deck;
}

/** 嘘（コールと違うカード）か判定 */
function wasLie(playedCards, currentCall) {
    return playedCards.some(card => !card.isJoker && card.rank !== currentCall);
}

/** 部屋の全員にメッセージを送信 */
function broadcast(roomId, message) {
    if (!rooms[roomId]) return;
    Object.values(rooms[roomId].players).forEach(player => {
        if (player.ws && player.ws.readyState === WebSocket.OPEN) {
            player.ws.send(JSON.stringify(message));
        }
    });
}

/** 部屋の状態を整形して送信 */
function sendFullGameState(roomId) {
    const room = rooms[roomId];
    if (!room) return;

    Object.entries(room.players).forEach(([pid, player]) => {
        if (player.ws && player.ws.readyState === WebSocket.OPEN) {
            const stateForPlayer = {
                type: 'updateState',
                payload: {
                    roomId: room.id,
                    status: room.status,
                    players: Object.fromEntries(Object.entries(room.players).map(([id, p]) => [id, { name: p.name, cardCount: p.hand.length }])),
                    gameState: room.gameState,
                    myHand: player.hand,
                    creatorId: room.creatorId,
                }
            };
            player.ws.send(JSON.stringify(stateForPlayer));
        }
    });
}

// ================= WebSocket処理 =================

wss.on('connection', (ws) => {
    let playerId = '';
    let roomId = '';

    ws.on('message', (message) => {
        try {
            const { type, payload } = JSON.parse(message);
            const room = rooms[roomId];

            switch (type) {
                case 'createRoom': {
                    playerId = payload.playerId;
                    roomId = Math.random().toString(36).substring(2, 8).toUpperCase();
                    rooms[roomId] = {
                        id: roomId,
                        creatorId: playerId,
                        players: {},
                        status: 'waiting',
                        gameState: null,
                        privateState: {
                            fieldCards: [],
                            lastPlayedCards: []
                        }
                    };
                    rooms[roomId].players[playerId] = { ws, name: payload.playerName, hand: [] };
                    ws.send(JSON.stringify({ type: 'roomCreated', payload: { roomId } }));
                    sendFullGameState(roomId);
                    console.log(`[${roomId}] Player ${payload.playerName}(${playerId}) created room.`);
                    break;
                }
                case 'joinRoom': {
                    const targetRoomId = payload.roomId.toUpperCase();
                    if (rooms[targetRoomId] && Object.keys(rooms[targetRoomId].players).length < MAX_PLAYERS && rooms[targetRoomId].status === 'waiting') {
                        roomId = targetRoomId;
                        playerId = payload.playerId;
                        rooms[roomId].players[playerId] = { ws, name: payload.playerName, hand: [] };
                        ws.send(JSON.stringify({ type: 'joinedRoom', payload: { roomId } }));
                        sendFullGameState(roomId);
                        console.log(`[${roomId}] Player ${payload.playerName}(${playerId}) joined.`);
                    } else {
                        ws.send(JSON.stringify({ type: 'error', payload: { message: '部屋が見つからないか、満員、またはゲームが始まっています。' } }));
                    }
                    break;
                }
                case 'startGame': {
                    if (room && room.creatorId === playerId && Object.keys(room.players).length >= 2) {
                        console.log(`[${roomId}] Game starting.`);
                        room.status = 'playing';
                        const playerIds = Object.keys(room.players);
                        
                        const deck = shuffleDeck(createDeck());
                        let p_idx = 0;
                        deck.forEach(card => {
                            room.players[playerIds[p_idx]].hand.push(card);
                            p_idx = (p_idx + 1) % playerIds.length;
                        });

                        room.gameState = {
                            turnOrder: playerIds,
                            turnPlayerId: playerIds[0],
                            lastPlayerId: null,
                            currentCall: 1,
                            fieldCardCount: 0,
                            winner: null,
                            challengeResult: null,
                        };
                        room.privateState = { fieldCards: [], lastPlayedCards: [] };
                        
                        sendFullGameState(roomId);
                    }
                    break;
                }
                case 'playCards': {
                    if (room && room.status === 'playing' && room.gameState.turnPlayerId === playerId) {
                        const player = room.players[playerId];
                        const playedCardIds = payload.cardIds;
                        
                        const playedCards = player.hand.filter(c => playedCardIds.includes(c.id));
                        if (playedCards.length !== playedCardIds.length || playedCards.length === 0 || playedCards.length > 4) {
                            return; // 不正操作
                        }

                        player.hand = player.hand.filter(c => !playedCardIds.includes(c.id));
                        room.privateState.lastPlayedCards = playedCards;
                        room.privateState.fieldCards.push(...playedCards);
                        
                        room.gameState.fieldCardCount = room.privateState.fieldCards.length;
                        room.gameState.lastPlayerId = playerId;
                        room.gameState.challengeResult = null;
                        
                        if (player.hand.length === 0) {
                            room.status = 'finished';
                            room.gameState.winner = playerId;
                        } else {
                            const currentPlayerIndex = room.gameState.turnOrder.indexOf(playerId);
                            room.gameState.turnPlayerId = room.gameState.turnOrder[(currentPlayerIndex + 1) % room.gameState.turnOrder.length];
                            room.gameState.currentCall = (room.gameState.currentCall % 13) + 1;
                        }

                        sendFullGameState(roomId);
                    }
                    break;
                }
                case 'challenge': {
                    if (room && room.status === 'playing' && room.gameState.lastPlayerId && room.gameState.lastPlayerId !== playerId) {
                        const challenger = room.players[playerId];
                        const challengedPlayerId = room.gameState.lastPlayerId;
                        const challengedPlayer = room.players[challengedPlayerId];
                        
                        const isLie = wasLie(room.privateState.lastPlayedCards, room.gameState.currentCall);
                        const loserId = isLie ? challengedPlayerId : playerId;
                        const loser = room.players[loserId];

                        loser.hand.push(...room.privateState.fieldCards);
                        
                        room.gameState.challengeResult = {
                            challengerName: challenger.name,
                            challengedName: challengedPlayer.name,
                            wasLie,
                            loserName: loser.name,
                        };
                        
                        room.privateState.fieldCards = [];
                        room.privateState.lastPlayedCards = [];
                        room.gameState.fieldCardCount = 0;
                        room.gameState.lastPlayerId = null;

                        sendFullGameState(roomId);
                    }
                    break;
                }
            }
        } catch (error) {
            console.error('Error processing message:', error);
        }
    });

    ws.on('close', () => {
        if (roomId && rooms[roomId] && rooms[roomId].players[playerId]) {
            console.log(`[${roomId}] Player ${rooms[roomId].players[playerId].name} disconnected.`);
            delete rooms[roomId].players[playerId];
            if (Object.keys(rooms[roomId].players).length === 0) {
                console.log(`[${roomId}] Room is empty, closing.`);
                delete rooms[roomId];
            } else {
                sendFullGameState(roomId);
            }
        }
    });
});

server.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});