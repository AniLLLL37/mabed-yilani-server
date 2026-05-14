const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const admin = require('firebase-admin');
const cors = require('cors');

const app = express();
app.use(cors());
const server = http.createServer(app);

const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] }
});

const WORLD_SIZE = 4000;
const SEGMENT_SPACING = 5; // Kaç geçmiş pozisyonda bir gövde eklenecek
const BASE_SPEED = 4.0;
const BOOST_SPEED = 8.0;

let snakes = {};
let foods = [];
let foodIdCounter = 0;

// Renk paleti
const COLORS = ['#FF0055', '#00F2FF', '#7000FF', '#FFD700', '#00FF41', '#FF8C00', '#FF00FF'];

// Rastgele yem üret
function spawnFood(count) {
    for (let i = 0; i < count; i++) {
        foods.push({
            id: foodIdCounter++,
            x: Math.random() * WORLD_SIZE,
            y: Math.random() * WORLD_SIZE,
            r: Math.random() * 3 + 2, // 2-5 arası yarıçap
            c: COLORS[Math.floor(Math.random() * COLORS.length)]
        });
    }
}
spawnFood(800); // Başlangıçta 800 yem

io.on('connection', (socket) => {
    console.log('Yeni bağlantı:', socket.id);

    socket.on('join_game', (data) => {
        // İleride Firebase Auth eklenecek
        const name = data.name || "İsimsiz Yılan";
        
        snakes[socket.id] = {
            id: socket.id,
            name: name,
            color: COLORS[Math.floor(Math.random() * COLORS.length)],
            x: Math.random() * WORLD_SIZE,
            y: Math.random() * WORLD_SIZE,
            angle: Math.random() * Math.PI * 2,
            targetAngle: 0,
            score: 10, // Başlangıç uzunluğu/skoru
            history: [],
            isBoosting: false
        };

        // Başlangıç tarihi (kuyruk için) doldur
        let s = snakes[socket.id];
        s.targetAngle = s.angle;
        for(let i=0; i<50; i++) {
            s.history.push({x: s.x, y: s.y});
        }

        socket.emit('init', { id: socket.id, foods: foods });
        console.log(`${name} oyuna katıldı.`);
    });

    socket.on('input', (data) => {
        let s = snakes[socket.id];
        if (s) {
            s.targetAngle = data.angle;
            s.isBoosting = data.boosting;
        }
    });

    socket.on('disconnect', () => {
        if(snakes[socket.id]) {
            spawnCorpse(snakes[socket.id]);
            delete snakes[socket.id];
        }
    });
});

// Yılan ölünce yeme dönüşsün
function spawnCorpse(snake) {
    let dropCount = Math.floor(snake.score / 2);
    let segments = getSegments(snake);
    for(let i=0; i<dropCount; i++) {
        if(segments.length === 0) break;
        let seg = segments[i % segments.length];
        foods.push({
            id: foodIdCounter++,
            x: seg.x + (Math.random()*20 - 10),
            y: seg.y + (Math.random()*20 - 10),
            r: 6, // Ölü yılan yemi daha büyüktür
            c: snake.color
        });
    }
}

// Kuyruk parçalarını history'den hesapla
function getSegments(snake) {
    let segments = [];
    let length = Math.floor(snake.score / 2) + 5; // Skora göre uzunluk
    for (let i = 0; i < length; i++) {
        let histIndex = i * SEGMENT_SPACING;
        if (histIndex < snake.history.length) {
            segments.push(snake.history[histIndex]);
        }
    }
    return segments;
}

// Ana Oyun Döngüsü (Saniyede 30 Kez)
setInterval(() => {
    let snakeList = Object.values(snakes);

    snakeList.forEach(s => {
        // Hız ayarı ve Dönüş (Smooth Rotation)
        let speed = BASE_SPEED;
        if (s.isBoosting && s.score > 15) {
            speed = BOOST_SPEED;
            s.score -= 0.2; // Hızlanınca skor düşer (Mekanik)
            
            // Hızlanırken arkada yem bırak
            if(Math.random() < 0.2) {
                let tail = s.history[s.history.length-1];
                if(tail) {
                    foods.push({ id: foodIdCounter++, x: tail.x, y: tail.y, r: 3, c: s.color });
                }
            }
        }

        // Açıyı hedefe doğru yavaşça döndür
        let diff = s.targetAngle - s.angle;
        // Açı farkını düzelt (-PI ile PI arası)
        while (diff < -Math.PI) diff += Math.PI * 2;
        while (diff > Math.PI) diff -= Math.PI * 2;
        
        let turnSpeed = 0.15;
        if (Math.abs(diff) < turnSpeed) s.angle = s.targetAngle;
        else s.angle += Math.sign(diff) * turnSpeed;

        // İleri Git
        s.x += Math.cos(s.angle) * speed;
        s.y += Math.sin(s.angle) * speed;

        // Harita Sınırları (Çarpınca Ölür)
        if (s.x < 0 || s.x > WORLD_SIZE || s.y < 0 || s.y > WORLD_SIZE) {
            spawnCorpse(s);
            io.to(s.id).emit('died');
            delete snakes[s.id];
            return;
        }

        // Geçmişi kaydet (Kuyruk için)
        s.history.unshift({ x: s.x, y: s.y });
        let maxLength = (Math.floor(s.score / 2) + 5) * SEGMENT_SPACING + 1;
        if (s.history.length > maxLength) {
            s.history.pop();
        }

        let headR = 15 + Math.min(s.score / 100, 10); // Kafa büyüklüğü
        
        // Yem Yeme Kontrolü
        for (let i = foods.length - 1; i >= 0; i--) {
            let f = foods[i];
            let dx = s.x - f.x;
            let dy = s.y - f.y;
            if (dx*dx + dy*dy < (headR + f.r) * (headR + f.r)) {
                s.score += (f.r > 5 ? 5 : 1); // Büyük yemde daha çok skor
                foods.splice(i, 1);
                io.emit('food_eaten', f.id); // Sadece yenen yemi silmesi için client'a haber ver
            }
        }

        // Yılan Çarpışma Kontrolü (Diğer yılanların gövdesine değme)
        for (let other of snakeList) {
            if (other.id === s.id) continue;
            let otherSegments = getSegments(other);
            for (let seg of otherSegments) {
                let dx = s.x - seg.x;
                let dy = s.y - seg.y;
                let otherR = 10 + Math.min(other.score / 100, 10);
                if (dx*dx + dy*dy < (headR + otherR) * (headR + otherR) * 0.6) {
                    // Kafam başkasının vücuduna değdi -> Öldüm
                    spawnCorpse(s);
                    io.to(s.id).emit('died');
                    delete snakes[s.id];
                    return; // Bu yılandan çık
                }
            }
        }
    });

    // Eksilen yemleri tamamla
    if (foods.length < 500) spawnFood(50);

    // Tüm istemcilere sadece yılanların gerekli pozisyonlarını yolla (Optimizasyon)
    let pack = snakeList.map(s => {
        return {
            id: s.id,
            name: s.name,
            color: s.color,
            score: Math.floor(s.score),
            segments: getSegments(s)
        };
    });

    // Eksilen/Eklenen yemleri ayrı yolla (Bütün yemi 60fps yollarsak ağ çöker)
    io.emit('state', { snakes: pack });

}, 1000 / 30); // 30 FPS Server Tick

// Her 1 saniyede yeni yemleri yolla
setInterval(() => {
    io.emit('new_foods', foods);
}, 1000);


const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
    console.log('MabedYilani Server çalışıyor. Port:', PORT);
});
