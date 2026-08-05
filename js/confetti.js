window._confettiFrameId = null;
window.startConfetti = function() {
  if (window._confettiFrameId) {
    cancelAnimationFrame(window._confettiFrameId);
    window._confettiFrameId = null;
  }
  const canvas = document.getElementById('confetti-canvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  
  canvas.width = rect.width * dpr;
  canvas.height = rect.height * dpr;
  ctx.scale(dpr, dpr);
  
  const width = rect.width;
  const height = rect.height;
  
  const particles = [];
  const balloons = [];
  const colors = ['#f44336', '#e91e63', '#9c27b0', '#673ab7', '#3f51b5', '#2196f3', '#03a9f4', '#00bcd4', '#009688', '#4CAF50', '#8BC34A', '#CDDC39', '#FFEB3B', '#FFC107', '#FF9800', '#FF5722'];
  
  for (let i = 0; i < 150; i++) {
    particles.push({
      x: Math.random() * width,
      y: (Math.random() * height) - height,
      r: Math.random() * 6 + 4,
      d: Math.random() * 150,
      color: colors[Math.floor(Math.random() * colors.length)],
      tilt: Math.floor(Math.random() * 10) - 10,
      tiltAngleInc: (Math.random() * 0.07) + 0.05,
      tiltAngle: 0,
      speedY: (Math.random() * 3) + 2,
      speedX: (Math.random() * 2) - 1
    });
  }

  for (let i = 0; i < 15; i++) {
    balloons.push({
      x: Math.random() * width,
      y: height + Math.random() * 300, // start below screen
      speedY: (Math.random() * 2) + 3,
      speedX: (Math.random() - 0.5) * 1,
      size: Math.random() * 15 + 25, // 25 to 40 radius
      color: colors[Math.floor(Math.random() * colors.length)],
      sway: Math.random() * Math.PI * 2,
      swaySpeed: (Math.random() * 0.03) + 0.01
    });
  }
  
  let angle = 0;
  let running = true;
  
  function draw() {
    if (!running) return;
    ctx.clearRect(0, 0, width, height);
    
    angle += 0.01;
    let itemsInScreen = 0;
    
    // Draw Confetti
    for (let i = 0; i < particles.length; i++) {
      const p = particles[i];
      
      p.tiltAngle += p.tiltAngleInc;
      p.y += p.speedY;
      p.x += Math.sin(angle + p.d) + p.speedX;
      
      if (p.y <= height) {
        itemsInScreen++;
      }
      
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.tiltAngle);
      ctx.fillStyle = p.color;
      ctx.fillRect(-p.r, -p.r/2, p.r*2, p.r);
      ctx.restore();
    }

    // Draw Balloons
    for (let i = 0; i < balloons.length; i++) {
      let b = balloons[i];
      b.y -= b.speedY;
      b.sway += b.swaySpeed;
      b.x += Math.sin(b.sway) * 1.2;
      
      if (b.y + b.size + 60 > 0) { // Keep running if balloons are still visible
        itemsInScreen++;
      }
      
      ctx.save();
      
      // Balloon body (ellipse)
      ctx.beginPath();
      ctx.ellipse(b.x, b.y, b.size * 0.85, b.size, 0, 0, 2 * Math.PI);
      ctx.fillStyle = b.color;
      ctx.fill();
      
      // Balloon reflection (highlight)
      ctx.beginPath();
      ctx.ellipse(b.x - b.size * 0.3, b.y - b.size * 0.4, b.size * 0.2, b.size * 0.4, Math.PI / 8, 0, 2 * Math.PI);
      ctx.fillStyle = 'rgba(255, 255, 255, 0.3)';
      ctx.fill();

      // Balloon tie
      ctx.beginPath();
      ctx.moveTo(b.x, b.y + b.size);
      ctx.lineTo(b.x - 5, b.y + b.size + 8);
      ctx.lineTo(b.x + 5, b.y + b.size + 8);
      ctx.closePath();
      ctx.fillStyle = b.color;
      ctx.fill();
      
      // Balloon string
      ctx.beginPath();
      ctx.moveTo(b.x, b.y + b.size + 8);
      // Create a slight curve for the string
      ctx.quadraticCurveTo(b.x + Math.sin(b.sway * 2) * 10, b.y + b.size + 30, b.x + Math.sin(b.sway) * 15, b.y + b.size + 60);
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.6)';
      ctx.lineWidth = 1;
      ctx.stroke();

      ctx.restore();
    }
    
    if (itemsInScreen > 0) {
      window._confettiFrameId = requestAnimationFrame(draw);
    } else {
      running = false;
      ctx.clearRect(0, 0, width, height);
      window._confettiFrameId = null;
    }
  }
  
  draw();
};
