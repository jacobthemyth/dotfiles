# iakobos dotfiles

I use [thoughtbot/dotfiles](https://github.com/thoughtbot/dotfiles) and
iakobos/dotfiles together using [the `*.local` convention][dot-local].

[dot-local]: http://robots.thoughtbot.com/manage-team-and-personal-dotfiles-together-with-rcm

## Requirements

Set zsh as my login shell.

    chsh -s /bin/zsh

Install [rcm](https://github.com/mike-burns/rcm).

    brew tap thoughtbot/formulae
    brew install rcm

## Install

Clone onto my laptop:

    git clone git://github.com/iakobos/dotfiles.git

Install:

    env RCRC=$HOME/.dotfiles/rcrc rcup

I can safely run `rcup` multiple times to update.

## Setup a new computer

[./setup](./setup) is a script to set up an OS X laptop for web development.

It can be run multiple times on the same machine safely. It installs, upgrades,
or skips packages based on what is already installed on the machine.

It is tightly coupled to
[thoughtbot/laptop](https://github.com/thoughtbot/laptop),
[thoughtbot/dotfiles](https://github.com/thoughtbot/dotfiles), and
[iakobos/dotfiles](https://github.com/iakobos/dotfiles).

### Make It So

```sh
curl -s https://raw.githubusercontent.com/iakobos/dotfiles/master/setup | sh 2>&1 | tee ~/setup.log
```
