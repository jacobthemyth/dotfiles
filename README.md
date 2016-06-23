jacobthemyth dotfiles
===============

I use [thoughtbot/dotfiles](https://github.com/thoughtbot/dotfiles) and
jacobthemyth/dotfiles together using [the `*.local` convention][dot-local].

[dot-local]: http://robots.thoughtbot.com/manage-team-and-personal-dotfiles-together-with-rcm

Requirements
------------

Set zsh as my login shell.

    chsh -s /bin/zsh

Install [rcm](https://github.com/mike-burns/rcm).

    brew tap thoughtbot/formulae
    brew install rcm

Install
-------

Clone onto my laptop:

    git clone git://github.com/jacobthemyth/dotfiles.git

Install:

    env RCRC=$HOME/jacobthemyth/dotfiles/rcrc rcup

I can safely run `rcup` multiple times to update.

What's in it?
-------------

Lot's of customizations for Vim & Tmux
