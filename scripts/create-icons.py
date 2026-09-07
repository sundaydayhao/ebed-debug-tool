from pathlib import Path
from PIL import Image, ImageDraw

root = Path(__file__).resolve().parents[1]
target = root / 'build'
target.mkdir(exist_ok=True)
im = Image.new('RGBA', (256, 256), (0, 0, 0, 0))
d = ImageDraw.Draw(im)
d.rounded_rectangle((6, 6, 250, 250), radius=55, fill='#137d69')
d.line([(45, 132), (86, 132), (108, 74), (144, 187), (167, 132), (211, 132)], fill='white', width=13, joint='curve')
im.save(target / 'icon.png')
im.save(target / 'icon.ico', sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
