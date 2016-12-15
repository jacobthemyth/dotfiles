'use strict';

/* Preferences */

Phoenix.set({
    'daemon': true,
    'openAtLogin': true
});

var ctrlCmd = [ 'ctrl', 'cmd' ];
var margin = 0;
var increment = 0.1;

/* Position */

var Position = {
  central: function (frame, window) {
    return {
      x: frame.x + ((frame.width - window.width) / 2),
      y: frame.y + ((frame.height - window.height) / 2)
    };
  },

  top: function (frame, window) {
    return {
      x: window.x,
      y: frame.y
    };
  },

  bottom: function (frame, window) {
    return {
      x: window.x,
      y: (frame.y + frame.height) - window.height
    };
  },

  left: function (frame, window) {
    return {
      x: frame.x,
      y: window.y
    };
  },

  right: function (frame, window) {
    return {
      x: (frame.x + frame.width) - window.width,
      y: window.y
    };
  },

  topLeft: function (frame, window, margin) {
    return {
      x: Position.left(frame, window).x + margin,
      y: Position.top(frame, window).y + margin
    };
  },

  topRight: function (frame, window, margin) {
    return {
      x: Position.right(frame, window).x - margin,
      y: Position.top(frame, window).y + margin
    };
  },

  bottomLeft: function (frame, window, margin) {
    return {
      x: Position.left(frame, window).x + margin,
      y: Position.bottom(frame, window).y - margin
    };
  },

  bottomRight: function (frame, window, margin) {
    return {
      x: Position.right(frame, window).x - margin,
      y: Position.bottom(frame, window).y - margin
    };
  }
};

/* Grid */

var Frame = {
  width: 1,
  height: 1,

  half: {
    width: 0.5,
    height: 0.5
  }
};

/* Window Functions */

Window.prototype.move = function (direction) {
  switch(direction) {
    case 'left':
      break;
    case 'right':
      break;
    case 'up':
      break;
    case 'down':
      break;
  }
}

Window.prototype.to = function (position) {
  this.setTopLeft(position(this.screen().visibleFrameInRectangle(),
                           this.frame(), margin));
}

Window.prototype.grid = function (x, y, origin) {
  origin = origin || 'topLeft';
  var frame = this.screen().visibleFrameInRectangle();

  var newWindowFrame = _(this.frame()).extend({
    width: (frame.width * x) - (2 * margin),
    height: (frame.height * y) - (2 * margin)
  });

  var position = Position[origin](frame, newWindowFrame, margin);

  this.setFrame(_(newWindowFrame).extend(position));
}

Window.prototype.resize = function (multiplier) {
  var frame = this.screen().visibleFrameInRectangle();
  var newSize = this.size();

  if (multiplier.x) {
    newSize.width += frame.width * multiplier.x;
  }

  if (multiplier.y) {
    newSize.height += frame.height * multiplier.y;
  }

  this.setSize(newSize);
}

Window.prototype.increaseWidth = function () {
  this.resize({ x: increment });
}

Window.prototype.decreaseWidth = function () {
  this.resize({ x: -increment });
}

Window.prototype.increaseHeight = function () {
  this.resize({ y: increment });
}

Window.prototype.decreaseHeight = function () {
  this.resize({ y: -increment });
}

/* Position Bindings */
Key.on('q', ctrlCmd, function () {
  Window.focused() && Window.focused().to(Position.topLeft);
});

Key.on('w', ctrlCmd, function () {
  Window.focused() && Window.focused().to(Position.topRight);
});

Key.on('a', ctrlCmd, function () {
  Window.focused() && Window.focused().to(Position.bottomLeft);
});

Key.on('s', ctrlCmd, function () {
  Window.focused() && Window.focused().to(Position.bottomRight);
});

Key.on('0', ctrlCmd, function () {
  Window.focused() && Window.focused().to(Position.central);
});

/* Grid Bindings */

Key.on('[', ctrlCmd, function () {
  Window.focused() &&
    Window.focused().grid(Frame.half.width, Frame.height);
});

Key.on(']', ctrlCmd, function () {
  Window.focused() &&
    Window.focused().grid(Frame.half.width, Frame.height, 'topRight');
});

Key.on('m', ctrlCmd, function () {
  Window.focused() &&
    Window.focused().grid(Frame.width, Frame.height);
});

/* Resize Bindings */

// < decrease current window width
Key.on(',', ctrlCmd, function () {
  Window.focused() && Window.focused().decreaseWidth();
});

// > increase current window width
Key.on('.', ctrlCmd, function () {
  Window.focused() && Window.focused().increaseWidth();
});

// - decrease current window height
Key.on('-', ctrlCmd, function () {
  Window.focused() && Window.focused().decreaseHeight();
});

// + increase current window height
Key.on('=', ctrlCmd, function () {
  Window.focused() && Window.focused().increaseHeight();
});
