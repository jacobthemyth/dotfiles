# iakobos dotfiles

## Install

[./setup](./setup) is a script to set up an OS X laptop for web development.

It can be run multiple times on the same machine safely. It installs, upgrades,
or skips packages based on what is already installed on the machine.

```sh
curl -s https://raw.githubusercontent.com/iakobos/dotfiles/master/setup | sh 2>&1 | tee ~/setup.log
```
