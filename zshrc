source ~/.profile
autoload -U promptinit; promptinit
eval "$(starship init zsh)"

for zsh_source in $HOME/.zsh/configs/*.zsh; do
  source $zsh_source
done

# load custom executable functions
for function in ~/.zsh/functions/*; do
  source $function
done

# makes color constants available
autoload -U colors
colors

# enable colored output from ls, etc. on FreeBSD-based systems
export CLICOLOR=1

# Show description in completion menu
zstyle ":completion:*:descriptions" format "%B%d%b"

export RBENV_BUILD_ROOT="$HOME/.rbenv/sources" # Force rbenv to always keep sources
eval "$(rbenv init - --no-rehash)"
FPATH="$FPATH:~/.zsh/functions"

export PATH="$HOME/.nodenv/bin:$PATH"
eval "$(nodenv init - --no-rehash)"

eval "$(pyenv init - --no-rehash)"

eval "$(direnv hook zsh)"

export PATH="$HOME/go/bin:$PATH"
export GOPATH="$HOME/go"

export PATH="$HOME/.cargo/bin:$PATH"
export PATH="$HOME/.bin:$PATH"
export PATH="$HOME/.config/emacs/bin:$PATH"
export PATH=".git/safe/../../bin:$PATH"

export FZF_DEFAULT_OPTS="--extended --cycle"

export VISUAL=nvim
export EDITOR=$VISUAL

# Set main key map to viins
bindkey -v

# Enable bash-style shortcuts in viins mode
bindkey -M viins "^A" beginning-of-line
bindkey -M viins "^E" end-of-line
bindkey -M viins "^K" kill-line
bindkey -M viins "^R" history-incremental-search-backward
bindkey -M viins "^P" history-search-backward
bindkey -M viins "^N" history-search-forward

# Enable Ctrl-x-e to edit command line
autoload -U edit-command-line
zle -N edit-command-line
bindkey '^xe' edit-command-line
bindkey '^x^e' edit-command-line

setopt hist_ignore_all_dups inc_append_history
HISTFILE=~/.zhistory
HISTSIZE=4096
SAVEHIST=4096

# awesome cd movements from zshkit
setopt autocd autopushd pushdminus pushdsilent pushdtohome cdablevars
DIRSTACKSIZE=5

# Enable extended globbing
setopt extendedglob

# Allow [ or ] whereever you want
unsetopt nomatch

setopt promptsubst

export OBJC_DISABLE_INITIALIZE_FORK_SAFETY=YES

export FZF_DEFAULT_COMMAND='rg --files'

setopt HIST_IGNORE_SPACE

# aliases
[[ -f ~/.aliases ]] && source ~/.aliases

[ -f ~/.fzf.zsh ] && source ~/.fzf.zsh
