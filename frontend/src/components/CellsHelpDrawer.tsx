import {
  Box,
  Drawer,
  Grid,
  Icon,
  IconButton,
  Portal,
  Stack,
  Text,
} from '@chakra-ui/react'
import { CircleHelp, X } from 'lucide-react'

type CellsHelpDrawerProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
}

type HelpSectionProps = {
  number: string
  title: string
  children: React.ReactNode
}

const HelpSection = ({ number, title, children }: HelpSectionProps) => (
  <Box as="section">
    <Grid templateColumns="1.75rem minmax(0, 1fr)" gap="3" alignItems="start">
      <Box
        display="flex"
        alignItems="center"
        justifyContent="center"
        w="1.75rem"
        h="1.75rem"
        borderRadius="full"
        bg="tide.500"
        color="white"
        fontSize="xs"
        fontWeight="700"
      >
        {number}
      </Box>
      <Box minW="0">
        <Text fontSize="sm" fontWeight="700" color="ink.900" mb="1.5">
          {title}
        </Text>
        <Stack spacing="2" fontSize="sm" color="ink.700" lineHeight="1.8">
          {children}
        </Stack>
      </Box>
    </Grid>
  </Box>
)

const Shortcut = ({ keys, action }: { keys: string; action: string }) => (
  <Grid templateColumns="5.5rem minmax(0, 1fr)" gap="3" alignItems="center">
    <Box
      as="kbd"
      justifySelf="start"
      px="2"
      py="1"
      borderRadius="md"
      border="1px solid"
      borderColor="sand.200"
      bg="sand.100"
      color="ink.900"
      fontSize="xs"
      fontFamily="mono"
      boxShadow="0 1px 0 var(--chakra-colors-sand-200)"
    >
      {keys}
    </Box>
    <Text fontSize="sm" color="ink.700">
      {action}
    </Text>
  </Grid>
)

const CellsHelpDrawer = ({ open, onOpenChange }: CellsHelpDrawerProps) => (
  <Drawer.Root
    open={open}
    onOpenChange={(details) => onOpenChange(details.open)}
    placement="end"
    size="sm"
  >
    <Drawer.Trigger asChild>
      <IconButton
        aria-label="セル画面の使い方を開く"
        title="使い方"
        size={{ base: 'xs', md: 'sm' }}
        h={{ base: '1.75rem', md: '2rem' }}
        minW={{ base: '1.75rem', md: '2rem' }}
        border="1px solid"
        borderColor="sand.200"
        bg="sand.100"
        color="ink.700"
        _hover={{ bg: 'sand.200', color: 'ink.900' }}
        flexShrink={0}
      >
        <Icon as={CircleHelp} boxSize={{ base: 3, md: 4 }} />
      </IconButton>
    </Drawer.Trigger>

    <Portal>
      <Drawer.Backdrop bg="rgba(11, 13, 16, 0.55)" />
      <Drawer.Positioner>
        <Drawer.Content
          bg="sand.50"
          color="ink.900"
          borderLeft="1px solid"
          borderColor="sand.200"
          maxW={{ base: 'calc(100vw - 1rem)', sm: '28rem' }}
        >
          <Drawer.Header
            px={{ base: 5, md: 6 }}
            py="5"
            borderBottom="1px solid"
            borderColor="sand.200"
            alignItems="flex-start"
          >
            <Box pr="10">
              <Drawer.Title fontSize="lg" color="ink.900">
                Cell Viewer の使い方
              </Drawer.Title>
              <Drawer.Description mt="1" color="ink.700" lineHeight="1.7">
                細胞画像の確認、ラベル付け、輪郭調整、派生画像の表示を行う画面です。
              </Drawer.Description>
            </Box>
          </Drawer.Header>

          <Drawer.Body
            px={{ base: 5, md: 6 }}
            py="5"
            overflowY="auto"
            overscrollBehavior="contain"
          >
            <Stack spacing="7" pb="6">
              <HelpSection number="1" title="表示する細胞を選ぶ">
                <Text>
                  <Text as="span" fontWeight="700" color="ink.900">Label Filter</Text>
                  {' '}で All / N/A / 1 / 2 / 3 を選ぶと、そのラベルの細胞だけに絞り込めます。変更すると先頭の細胞へ戻ります。
                </Text>
                <Text>
                  現在の細胞ID、ラベル、全体の何件目かは
                  {' '}<Text as="span" fontWeight="700" color="ink.900">Navigator</Text>
                  {' '}で確認できます。
                </Text>
              </HelpSection>

              <HelpSection number="2" title="画像を確認する">
                <Text>
                  PH（位相差）、FLUO1、FLUO2 の3画像を並べて確認できます。FLUOの色は各画像上部のメニューで変更できます。
                </Text>
                <Text>
                  <Text as="span" fontWeight="700" color="ink.900">Contour</Text>
                  {' '}は輪郭線、
                  <Text as="span" fontWeight="700" color="ink.900">Scale</Text>
                  {' '}はスケールバーの表示切り替えです。各チャンネル名の横にあるダウンロードボタンから、表示中のPNGを保存できます。
                </Text>
              </HelpSection>

              <HelpSection number="3" title="前後の細胞へ移動する">
                <Text>
                  画像下の Previous / Next、またはスライダーで移動します。キーボードでも素早く巡回できます。
                </Text>
                <Stack spacing="2.5" mt="1">
                  <Shortcut keys="Enter" action="次の細胞へ移動" />
                  <Shortcut keys="Space" action="前の細胞へ移動" />
                </Stack>
              </HelpSection>

              <HelpSection number="4" title="ラベルを付ける">
                <Text>
                  <Text as="span" fontWeight="700" color="ink.900">Manual label</Text>
                  {' '}を変更すると、現在の細胞へすぐに保存されます。入力欄や選択メニューにフォーカスがないときは、次のキーも使えます。
                </Text>
                <Stack spacing="2.5" mt="1">
                  <Shortcut keys="N" action="N/A に設定" />
                  <Shortcut keys="1 / 2 / 3" action="対応するラベルに設定" />
                </Stack>
              </HelpSection>

              <HelpSection number="5" title="画像表示・輪郭を調整する">
                <Text>
                  <Text as="span" fontWeight="700" color="ink.900">Gain</Text>
                  {' '}はFLUO画像の明るさを倍率で調整し、Applyで表示へ反映します。
                  <Text as="span" fontWeight="700" color="ink.900"> Optical boost</Text>
                  {' '}は選択した時点でFLUO画像のコントラストを強調します。どちらもデータベースの画像は変更しません。
                </Text>
                <Text>
                  <Text as="span" fontWeight="700" color="ink.900">Elastic contour</Text>
                  {' '}は輪郭を調整します。正のΔで膨張、負のΔで収縮します。Applyは現在の細胞、Apply bulkは現在のLabel Filterに該当する全細胞へ適用します。
                </Text>
                <Box
                  px="3"
                  py="2.5"
                  borderRadius="md"
                  border="1px solid"
                  borderColor="violet.300"
                  bg="sand.100"
                >
                  <Text fontSize="xs" color="ink.900" lineHeight="1.7">
                    注意：Elastic contour はデータベースに保存されます。特に Apply bulk は対象範囲を確認してから実行してください。
                  </Text>
                </Box>
              </HelpSection>

              <HelpSection number="6" title="Function Panel を使う">
                <Text>Draw modeで、現在の細胞を次の形式に切り替えて確認できます。</Text>
                <Box as="ul" ps="5" m="0">
                  <Box as="li" mb="1"><Text as="span" fontWeight="700" color="ink.900">Contour</Text>：保存済みの輪郭</Box>
                  <Box as="li" mb="1"><Text as="span" fontWeight="700" color="ink.900">Replot</Text>：細胞の向きをそろえた再描画。MeshをONにすると、長軸上の等間隔の点から左右の輪郭まで垂直な線を表示</Box>
                  <Box as="li" mb="1"><Text as="span" fontWeight="700" color="ink.900">Overlay / Raw / Fluo</Text>：チャンネルの重ね合わせ</Box>
                  <Box as="li" mb="1"><Text as="span" fontWeight="700" color="ink.900">Heatmap</Text>：中心線方向の蛍光ヒートマップ</Box>
                  <Box as="li" mb="1"><Text as="span" fontWeight="700" color="ink.900">Map 256 / Map Raw</Text>：正規化マップとJet表示</Box>
                  <Box as="li"><Text as="span" fontWeight="700" color="ink.900">Distribution</Text>：細胞内の輝度分布</Box>
                </Box>
                <Text>
                  モードに応じてChannel選択が表示されます。目的のFLUOチャンネルやOverlayを選んでください。
                </Text>
              </HelpSection>
            </Stack>
          </Drawer.Body>

          <Drawer.CloseTrigger asChild>
            <IconButton
              aria-label="使い方を閉じる"
              title="閉じる"
              size="sm"
              variant="ghost"
              color="ink.700"
              top="3.5"
              insetEnd="3.5"
              _hover={{ bg: 'sand.200', color: 'ink.900' }}
            >
              <X size={18} />
            </IconButton>
          </Drawer.CloseTrigger>
        </Drawer.Content>
      </Drawer.Positioner>
    </Portal>
  </Drawer.Root>
)

export default CellsHelpDrawer
