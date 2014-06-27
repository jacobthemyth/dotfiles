ZSH_CUSTOM=$HOME/.zsh
ZSH=$HOME/.oh-my-zsh
ZSH_THEME="avit"

# Turn off control flow
stty -ixon -ixoff

# Aliases

alias ip="dig +short myip.opendns.com @resolver1.opendns.com"
alias localip="ipconfig getifaddr en1"
alias gitjk="history 10 | tail -r | gitjk_cmd"
alias marked="open -a Marked.app"
alias ft="open -a FoldingText.app"

# Uncomment following line if you want red dots to be displayed while waiting for completion
COMPLETION_WAITING_DOTS="true"

# Uncomment following line if you don't want greedy autocomplete
setopt MENU_COMPLETE

# Show description in completion menu
zstyle ":completion:*:descriptions" format "%B%d%b"

ZSH_HIGHLIGHT_HIGHLIGHTERS=(main brackets root)
plugins=(tm tmux vi-mode zsh-syntax-highlighting)
source $ZSH/oh-my-zsh.sh

source ~/.profile
source ~/.ghiconfig

if which rbenv > /dev/null; then eval "$(rbenv init -)"; fi

# Turn on vi-mode
bindkey -v

# backspace ,^h, ^u working even after returning from command mode
bindkey '^?' backward-delete-char
bindkey '^h' backward-delete-char
bindkey '^u' backward-kill-line

# ctrl-w removed word backwards
bindkey '^w' backward-kill-word

# ctrl-r starts searching history backward
bindkey '^r' history-incremental-search-backward

bindkey '^[[A' up-line-or-search
bindkey '^[[B' down-line-or-search

bindkey "^a" beginning-of-line
bindkey "^e" end-of-line

# Brett Terpstra 2014
# <http://brettterpstra.com>
#
# tmux wrapper
#   tm session-name [window-name]
# Names can be partial from the beginning and first match will connect.
# If no match is found a new session will be created.
# If there's a second argument, it will be used to attach directly to a
# window in the session, or to name the first window in a new session.
tm() {
  local attach window
  if [ -n $1 ]; then
    attach=""

    tmux has-session -t $1 > /dev/null
    if [ $? -eq 0 ]; then
      attach=$1
      shift
    else
      for session in `tmux ls|awk -F ":" '{ print $1 }'`;do
        if [[ $session =~ ^$1  ]]; then
          echo "Matched session: $session"
          attach=$session
          shift
          break
        fi
      done
    fi

    if [[ $attach != "" ]]; then
      if [ $# -eq 1 ]; then
        for win in `tmux list-windows -t $attach|sed -E 's/^[0-9]+: //'|sed -E 's/[*-].*//'`;do
          if [[ $win =~ ^$1 ]]; then
            echo "Matched window: $window"
            window=$win
            break
          fi
        done

        tmux attach -t $attach:$window
      else
        tmux attach -t $attach
      fi
    else
      if [ $# -gt 1 ]; then
        attach=$1
        shift
        tmux new -s $attach -n $1
      else
        echo "Attempting to create $1"
        tmux new -s $1
      fi
    fi
  else
    tmux new
  fi
}
